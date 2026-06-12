import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";

/** Minimal raw test client speaking NDJSON JSON-RPC. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  readonly errors: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.id === null && msg.error) {
              c.errors.push(msg);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
      },
    });
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }

  async waitForNotification(predicate: (n: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.notifications.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for notification");
  }
}

describe("daemon IPC", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;

  async function boot(): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets });
    harnessToken = daemon.tokens.harness;
  }

  afterEach(() => daemon?.stop());

  test("methods before hello are rejected with UNAUTHORIZED", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.error.code).toBe(-32001);
    c.close();
  });

  test("hello with bad token rejected; with good token accepted", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    expect((await c.hello("nope", "bad")).error.code).toBe(-32001);
    const ok = await c.hello(harnessToken, "good");
    expect(ok.result.ok).toBe(true);
    expect(ok.result.protocolVersion).toBe(PROTOCOL_VERSION);
    c.close();
  });

  test("hello with wrong protocolVersion rejected with VERSION_MISMATCH", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.hello, {
      protocolVersion: 999, role: "harness", token: harnessToken, clientName: "future",
    });
    expect(res.error.code).toBe(-32002);
    c.close();
  });

  test("DONE GATE: two authenticated clients attach to one session and see each other's events", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    await b.hello(harnessToken, "client-b");

    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });
    await a.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await b.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    // a sees b's attachment
    await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "harness_attached" && n.params.clientName === "client-b");

    // b sends; a receives the user_message
    await b.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "hello from b" });
    const got = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message");
    expect(got.params.text).toBe("hello from b");
    expect(got.params.clientName).toBe("client-b");

    // b detaches; a sees it
    b.close();
    await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "harness_detached" && n.params.clientName === "client-b");
    a.close();
  });

  test("attach to nonexistent session → NOT_FOUND; send without attach → NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "lost");
    const attach = await c.request(METHODS.sessionAttach, { sessionId: "s_nope", fromSeq: 0 });
    expect(attach.error.code).toBe(-32004);
    const send = await c.request(METHODS.sessionSend, { sessionId: "s_nope", text: "x" });
    expect(send.error.code).toBe(-32004);
    c.close();
  });

  test("session.list returns the index shape", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "lister");
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    const { result } = await c.request(METHODS.sessionList);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: created.result.sessionId, scope: "global", lastSeq: 1 });
    expect(result.sessions[0].createdAt).toBeGreaterThan(0);
    c.close();
  });

  test("malformed JSON line gets an id:null error frame that our own schema accepts", async () => {
    await boot();
    const { RpcResponse } = await import("@norma/protocol");
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "garbler");
    (c as any).socket.write(new TextEncoder().encode("THIS IS NOT JSON\n"));
    await new Promise((r) => setTimeout(r, 50));
    const frame = c.errors[0];
    expect(frame).toBeTruthy();
    expect(frame.id).toBeNull();
    expect(() => RpcResponse.parse(frame)).not.toThrow();
    expect(frame.error.code).toBe(-32700);
    c.close();
  });
});
