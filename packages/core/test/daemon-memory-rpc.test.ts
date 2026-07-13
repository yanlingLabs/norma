import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startIpcServer } from "../src/ipc/server";
import { SessionStore } from "../src/sessions/store";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";

// Phase 5b Task 3 (design doc §4): the memory.list/read/write/delete/audit RPCs over the daemon's
// real MemoryStore (wired unconditionally in daemon.ts — memoryStore needs only normaHome/trust,
// no agentProvider — same precedent as routines/skills/mcp; see server.test.ts's "routines.* RPCs"
// describe block, which this file mirrors: a dedicated real-daemon TestClient harness, kept in its
// own file rather than folded into server.test.ts's already-3000-line suite).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated (not imported) from
 *  server.test.ts's own TestClient, matching every other *.test.ts in this directory
 *  (peripheral/e2e.test.ts, plugins/gate-4d-ii.test.ts, ...): each carries its own copy, there is
 *  no shared test-harness module. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
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
}

describe("memory.* RPCs (Phase 5b Task 3)", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;

  async function boot(): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-memory-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;
  }

  afterEach(() => daemon?.stop());

  test("write -> list -> read -> delete round trip (user scope)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");

    const written = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "coffee-pref", description: "Likes oat milk lattes", body: "Prefers oat milk.",
    });
    expect(written.error).toBeUndefined();
    expect(written.result).toEqual({});

    const listed = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listed.error).toBeUndefined();
    expect(listed.result.facts).toEqual([{ name: "coffee-pref", description: "Likes oat milk lattes", type: "user" }]);

    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "coffee-pref" });
    expect(read.error).toBeUndefined();
    expect(read.result.fact).toEqual({
      name: "coffee-pref", description: "Likes oat milk lattes", type: "user", body: "Prefers oat milk.",
    });

    const deleted = await c.request(METHODS.memoryDelete, { scope: "user", name: "coffee-pref" });
    expect(deleted.error).toBeUndefined();
    expect(deleted.result).toEqual({});

    const listedAfter = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listedAfter.result.facts).toEqual([]);
    c.close();
  });

  test("memory.write's optional type defaults to 'user' over the wire, same as the tool", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "a" });
    expect(read.result.fact.type).toBe("user");
    c.close();
  });

  test("memory.audit returns newest FIRST and records source:'rpc' with no sessionId", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d1", body: "b1" });
    await c.request(METHODS.memoryWrite, { scope: "user", name: "b", description: "d2", body: "b2" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "a" });

    const audit = await c.request(METHODS.memoryAudit, {});
    expect(audit.error).toBeUndefined();
    expect(audit.result.lines).toHaveLength(3);
    // newest-first: the delete (3rd mutation) leads, the first write trails.
    expect(audit.result.lines[0]).toMatchObject({ action: "delete", name: "a", source: "rpc", scope: "user" });
    expect(audit.result.lines[0].sessionId).toBeUndefined();
    expect(audit.result.lines[2]).toMatchObject({ action: "write", name: "a", source: "rpc" });

    const limited = await c.request(METHODS.memoryAudit, { limit: 1 });
    expect(limited.result.lines).toHaveLength(1);
    expect(limited.result.lines[0]).toMatchObject({ action: "delete", name: "a" });
    c.close();
  });

  test("project scope on an untrusted cwd -> INVALID_PARAMS for every verb, nothing persisted", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-project-"));

    const w = await c.request(METHODS.memoryWrite, {
      scope: "project", name: "x", description: "d", body: "b", cwd: projectDir,
    });
    expect(w.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(w.error?.message).toBe("project memory requires a trusted directory");
    expect(existsSync(join(projectDir, ".norma", "memory", "x.md"))).toBe(false);

    const l = await c.request(METHODS.memoryList, { scope: "project", cwd: projectDir });
    expect(l.error?.code).toBe(ERR.INVALID_PARAMS);

    const r = await c.request(METHODS.memoryRead, { scope: "project", name: "x", cwd: projectDir });
    expect(r.error?.code).toBe(ERR.INVALID_PARAMS);

    const d = await c.request(METHODS.memoryDelete, { scope: "project", name: "x", cwd: projectDir });
    expect(d.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("project scope on a directory trusted via daemon.trustDir round-trips under <cwd>/.norma/memory", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-project-"));
    const trusted = await c.request(METHODS.trustDir, { path: projectDir });
    expect(trusted.error).toBeUndefined();

    const w = await c.request(METHODS.memoryWrite, {
      scope: "project", name: "x", description: "d", body: "b", cwd: projectDir,
    });
    expect(w.error).toBeUndefined();
    expect(existsSync(join(projectDir, ".norma", "memory", "x.md"))).toBe(true);

    const read = await c.request(METHODS.memoryRead, { scope: "project", name: "x", cwd: projectDir });
    expect(read.result.fact).toMatchObject({ name: "x", description: "d", body: "b" });
    c.close();
  });

  test("memory.read on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const res = await c.request(METHODS.memoryRead, { scope: "user", name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("memory.delete on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const res = await c.request(METHODS.memoryDelete, { scope: "user", name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("schema validation: bad scope, missing name, and reserved/invalid slug names are all INVALID_PARAMS", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");

    const badScope = await c.request(METHODS.memoryList, { scope: "bogus" });
    expect(badScope.error?.code).toBe(ERR.INVALID_PARAMS);

    const missingName = await c.request(METHODS.memoryRead, { scope: "user", name: "" });
    expect(missingName.error?.code).toBe(ERR.INVALID_PARAMS);

    const reservedName = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "memory", description: "d", body: "b",
    });
    expect(reservedName.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(reservedName.error?.message).toContain("reserved name");

    const invalidSlug = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "Not_A_Slug", description: "d", body: "b",
    });
    expect(invalidSlug.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // A bare IPC server (own SessionStore + TokenAuthority, no memoryStore wired) mirrors
  // server.test.ts's `bootPluginTestServer` — RunningDaemon doesn't expose its SessionStore, so
  // the shared boot()/daemon fixture above can't mint plugin tokens. The role gate (ipc/server.ts,
  // checked BEFORE the switch) rejects a plugin connection regardless of whether `memory` is wired.
  test("memory.* verbs are role-rejected for a plugin connection, exactly like routines.*", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memory-plugin-role-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });

    const raw = store.mintPluginToken("sample-echo");
    const plugin = await TestClient.connect(socketPath);
    await plugin.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
    });
    for (const [method, params] of [
      [METHODS.memoryList, { scope: "user" }],
      [METHODS.memoryRead, { scope: "user", name: "x" }],
      [METHODS.memoryWrite, { scope: "user", name: "x", description: "d", body: "b" }],
      [METHODS.memoryDelete, { scope: "user", name: "x" }],
      [METHODS.memoryAudit, {}],
    ] as const) {
      const res = await plugin.request(method, params);
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    }
    plugin.close(); server.stop(); store.close();
  });
});
