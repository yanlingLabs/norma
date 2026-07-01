import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import type { Provider } from "../src/providers/types";

/** Minimal raw test client speaking NDJSON JSON-RPC. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  readonly errors: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

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
        drain(_s) {
          c.writer.onDrain();
        },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
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

  async function boot(
    serverOpts: { helloTimeoutMs?: number; maxConnections?: number } = {},
    provider?: Provider,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home, secrets, server: serverOpts,
      agentProvider: provider ? { provider, model: "fake-1" } : null,
    });
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

  test("bad params yield INVALID_PARAMS (-32602) with sanitized message", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "zod");
    const res = await c.request(METHODS.sessionCreate, { scope: "UPPER NOT VALID" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("invalid params");
    expect(res.error.message).not.toContain("regex"); // no internal zod dump
    c.close();
  });

  test("second hello on an authed connection is rejected with INVALID_REQUEST", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "once");
    const again = await c.hello(harnessToken, "twice");
    expect(again.error.code).toBe(-32600);
    // original auth still works:
    const list = await c.request(METHODS.sessionList);
    expect(list.result.sessions).toEqual([]);
    c.close();
  });

  test("malformed hello params yield INVALID_PARAMS", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.hello, { protocolVersion: "nope", role: "harness", token: "t", clientName: "x" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("protocolVersion");
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

  test("pre-hello oversized line disconnects the client", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    // >64KiB without a newline, in 8KB writes (Bun caps a single write at 8192 bytes)
    const chunk = new TextEncoder().encode("x".repeat(8_000));
    for (let i = 0; i < 9; i++) {
      (c as any).socket.write(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 100));
    const hello = c.hello(harnessToken, "late");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    c.close();
  });

  test("no hello within the deadline disconnects the client", async () => {
    await boot({ helloTimeoutMs: 100 });
    const c = await TestClient.connect(daemon.socketPath);
    await new Promise((r) => setTimeout(r, 200));
    const hello = c.hello(harnessToken, "tooslow");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    c.close();
  });

  test("connection cap rejects the N+1th connection", async () => {
    await boot({ maxConnections: 2 });
    const c1 = await TestClient.connect(daemon.socketPath);
    const c2 = await TestClient.connect(daemon.socketPath);
    const c3 = await TestClient.connect(daemon.socketPath);
    await new Promise((r) => setTimeout(r, 50));
    const hello = c3.hello(harnessToken, "overflow");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    [c1, c2, c3].forEach((c) => c.close());
  });

  test("a >8KB frame is delivered intact (ConnWriter drain path)", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "big-a");
    await b.hello(harnessToken, "big-b");
    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });
    await a.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await b.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const big = "x".repeat(20_000);
    await b.request(METHODS.sessionSend, { sessionId: created.sessionId, text: big });
    const got = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message");
    expect(got.params.text).toHaveLength(20_000);
    expect(got.params.text).toBe(big);
    a.close(); b.close();
  });

  test("user_message triggers an agent turn; events broadcast to attached harnesses", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([[
      { type: "text_delta", delta: "agent says hi" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "asker");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "hello?" });
    const msg = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "assistant_message");
    expect(msg.params.text).toBe("agent says hi");
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("approval.respond resolves a pending approval (first-wins over the wire)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"f.txt","content":"x"}' }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "approver");
    const cwd = mkdtempSync(join(tmpdir(), "norma-approve-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write f" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");
    const res = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("x");
    c.close();
  });

  test("without a provider, sessions behave as Phase 0 (echo only, no agent events)", async () => {
    await boot(); // no provider injected
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "plain");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "anyone home?" });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.notifications.some((n) => n.params?.type === "turn_started")).toBe(false);
    c.close();
  });
});
