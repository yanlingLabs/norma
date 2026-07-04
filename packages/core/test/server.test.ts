import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startIpcServer } from "../src/ipc/server";
import { SessionStore } from "../src/sessions/store";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";
import { PluginStore } from "../src/agent/plugins";
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
    // Pre-seed settings.json (e.g. `{ reviewer: { enabled: false } }`) before the daemon reads
    // it — used by tests that exercise the "auto"-policy bash path with a scripted FakeProvider,
    // where the (default-on) safety reviewer would otherwise consume the same provider's
    // single-track script queue meant for the turn itself. Reviewer *behavior* has its own
    // dedicated coverage in test/agent/engine-reviewer.test.ts.
    settingsOverride?: Record<string, unknown>,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    if (settingsOverride) {
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "codex-oauth", model: "gpt-5.4" },
        ...settingsOverride,
      }));
    }
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

  test("G2: session_created broadcasts to every authed harness (spec §4.4), even one attached to nothing", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    await b.hello(harnessToken, "client-b"); // b never attaches to anything

    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });

    // b, attached to nothing, still learns about the brand-new session (this is the live-gate bug:
    // previously only attachments received session_created, and a new session has none yet).
    const seenByB = await b.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "session_created" && n.params.sessionId === created.sessionId);
    expect(seenByB.params.scope).toBe("global");

    // a (the creator) gets it too — clients dedupe on sessionId/seq.
    const seenByA = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "session_created" && n.params.sessionId === created.sessionId);
    expect(seenByA.params.scope).toBe("global");

    a.close(); b.close();
  });

  test("G2: a harness whose hello failed never joins the broadcast set — receives no session_created", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const bad = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    const failed = await bad.hello("nope-bad-token", "never-authed");
    expect(failed.error.code).toBe(ERR.UNAUTHORIZED);

    await a.request(METHODS.sessionCreate, { scope: "global" });

    // Give the (nonexistent) delivery a beat, then confirm nothing arrived on the unauthed socket.
    await new Promise((r) => setTimeout(r, 100));
    expect(bad.notifications).toHaveLength(0);

    a.close(); bad.close();
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
    const cwd = mkdtempSync(join(tmpdir(), "norma-turn-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
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

  test("ask_user.respond round-trip + alreadyResolved; task.list snapshot", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify({
        questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
      }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t1", name: "task_create", argsJson: JSON.stringify({ subject: "Ship it" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "ask-tasker");
    const cwd = mkdtempSync(join(tmpdir(), "norma-askuser-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "ask, then track a task" });

    const asked = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "question_asked");
    const res1 = await c.request(METHODS.askUserRespond, { sessionId: created.sessionId, callId: asked.params.callId, answers: { "Pick one": "B" } });
    expect(res1.result).toEqual({ ok: true, alreadyResolved: false });
    const res2 = await c.request(METHODS.askUserRespond, { sessionId: created.sessionId, callId: asked.params.callId, answers: { "Pick one": "B" } });
    expect(res2.result).toEqual({ ok: true, alreadyResolved: true });

    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    const list = await c.request(METHODS.taskList, { sessionId: created.sessionId });
    expect(list.result).toEqual({ ok: true, tasks: [{ id: "1", subject: "Ship it", status: "pending" }] });
    c.close();
  });

  test("plan.respond round-trip + alreadyResolved", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: ship it" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "planner");
    const cwd = mkdtempSync(join(tmpdir(), "norma-plan-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "plan" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "make a plan" });

    const presented = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plan_presented");
    const res1 = await c.request(METHODS.planRespond, { sessionId: created.sessionId, callId: presented.params.callId, approved: true, autoAccept: true });
    expect(res1.result).toEqual({ ok: true, alreadyResolved: false });
    const res2 = await c.request(METHODS.planRespond, { sessionId: created.sessionId, callId: presented.params.callId, approved: true, autoAccept: true });
    expect(res2.result).toEqual({ ok: true, alreadyResolved: true });

    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.setPolicy round-trip; NOT_FOUND on an unknown session", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "policy-setter");
    const cwd = mkdtempSync(join(tmpdir(), "norma-setpolicy-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "plan" });
    const setPolicy = await c.request(METHODS.sessionSetPolicy, { sessionId: created.sessionId, policy: "auto" });
    expect(setPolicy.result).toEqual({ ok: true });

    const bad = await c.request(METHODS.sessionSetPolicy, { sessionId: "s_does_not_exist", policy: "auto" });
    expect(bad.error).toBeTruthy();
    expect(bad.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("thread.list without an engine → empty threads", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "threader-noeng");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const noEngine = await c.request(METHODS.threadList, { sessionId: created.sessionId });
    expect(noEngine.result).toEqual({ ok: true, threads: [] });
    c.close();
  });

  test("thread.list with an engine → main thread seeded lazily on first read", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "threader");
    const cwd = mkdtempSync(join(tmpdir(), "norma-threadlist-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    const list = await c.request(METHODS.threadList, { sessionId: created.sessionId });
    expect(list.result).toEqual({ ok: true, threads: [{ threadId: "main", status: "running" }] });
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

  test("bash tool runs end-to-end through a daemon-wired engine (auto policy)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const { existsSync } = await import("node:fs");
    if (process.platform !== "darwin") return; // sandbox-exec required
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: "echo hi > out.txt" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires bash, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "bash-runner");
    const cwd = mkdtempSync(join(tmpdir(), "norma-bashwire-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "make out.txt" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(cwd, "out.txt"))).toBe(true);
    c.close();
  });

  test("session.addDir widens roots; bash can then write the added dir", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    if (process.platform !== "darwin") return; // sandbox-exec required
    const added = mkdtempSync(join(tmpdir(), "norma-added-"));
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: `echo hi > ${added}/f.txt` }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires addDir/bash, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "adder");
    const cwd = mkdtempSync(join(tmpdir(), "norma-adder-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const add = await c.request(METHODS.sessionAddDir, { sessionId: created.sessionId, path: added });
    expect(add.result.roots).toContain(realpathSync(added));
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write in added dir" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(added, "f.txt"))).toBe(true);
    c.close();
  });

  test("session.setCwd changes the dir a new turn runs in", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "moved.txt", content: "here" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mover");
    const cwd1 = mkdtempSync(join(tmpdir(), "norma-cwd1-"));
    const cwd2 = mkdtempSync(join(tmpdir(), "norma-cwd2-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd: cwd1, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const setCwd = await c.request(METHODS.sessionSetCwd, { sessionId: created.sessionId, cwd: cwd2 });
    expect(setCwd.result).toEqual({ ok: true, cwd: cwd2 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write moved" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(cwd2, "moved.txt"))).toBe(true);
    c.close();
  });

  test("startIpcServer refuses an engine without a shared hub", () => {
    // Build a throwaway engine; we only need the constructor guard to fire.
    expect(() => {
      const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-guard-")));
      startIpcServer({
        socketPath: join(mkdtempSync(join(tmpdir(), "norma-guard-sock-")), "s.sock"),
        serverVersion: "test", tokens: {} as any, store,
        engine: {} as any, // engine present...
        // ...no hub
      });
    }).toThrow(/hub/);
  });

  test("session.create reports trusted=false for an untrusted dir, true after daemon.trustDir", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "truster");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-cwd-")));
    const created = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result;
    expect(created.trusted).toBe(false);
    const t = (await c.request(METHODS.trustDir, { path: cwd })).result;
    expect(t).toEqual({ ok: true, trusted: true });
    const created2 = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result;
    expect(created2.trusted).toBe(true); // now trusted (persisted)
    c.close();
  });

  test("committed additionalDirectories apply only after the folder is trusted", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "truster2");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-cwd2-")));
    const granted = realpathSync(mkdtempSync(join(tmpdir(), "norma-committed-")));
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [granted] } }));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    // Untrusted: committed dir NOT in roots (roots come back via addDir echo of the full set)
    const before = (await c.request(METHODS.sessionAddDir, { sessionId: s, path: cwd })).result.roots; // add cwd (noop-ish), read roots
    expect(before).not.toContain(granted);
    await c.request(METHODS.trustDir, { path: cwd });
    const after = (await c.request(METHODS.sessionAddDir, { sessionId: s, path: cwd })).result.roots;
    expect(after).toContain(granted); // committed dir now present
    c.close();
  });

  test("session.addDir on an unknown session fails and adds no dangling entry", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "adder-bad");
    const res = await c.request(METHODS.sessionAddDir, {
      sessionId: "s_does_not_exist",
      path: realpathSync(mkdtempSync(join(tmpdir(), "norma-x-"))),
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("bg.list/peek/kill over the socket", async () => {
    if (process.platform !== "darwin") return;
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-bgsrv-")));
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: "echo hi; sleep 2", runInBackground: true }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "started" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires bg tasks, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "bg");
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "run bg" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "bg_task_started");
    const list = (await c.request(METHODS.bgList, { sessionId: s })).result;
    expect(list.tasks.length).toBe(1);
    const taskId = list.tasks[0].taskId;
    await new Promise((r) => setTimeout(r, 300));
    const peek = (await c.request(METHODS.bgPeek, { sessionId: s, taskId })).result;
    expect(peek.chunk).toContain("hi");
    const kill = (await c.request(METHODS.bgKill, { sessionId: s, taskId })).result;
    expect(kill).toEqual({ ok: true });
    c.close();
  });

  test("session.interrupt aborts a running turn (wasRunning:true, turn_completed aborted)", async () => {
    const { AbortAwaitProvider } = await import("../src/agent/test-providers");
    await boot({}, new AbortAwaitProvider());
    const c = await TestClient.connect(daemon.socketPath); await c.hello(harnessToken, "int");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-int-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "go" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_started");
    const r = (await c.request(METHODS.sessionInterrupt, { sessionId: s })).result;
    expect(r).toEqual({ ok: true, wasRunning: true });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed" && n.params.stopReason === "aborted");
    c.close();
  });

  test("session.interrupt with no running turn is a no-op (wasRunning:false)", async () => {
    const { AbortAwaitProvider } = await import("../src/agent/test-providers");
    await boot({}, new AbortAwaitProvider());
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "int-idle");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-int-idle-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    const r = (await c.request(METHODS.sessionInterrupt, { sessionId: s })).result;
    expect(r).toEqual({ ok: true, wasRunning: false });
    c.close();
  });

  test("session.steer injects into a running turn (injected:true) and emits user_message", async () => {
    const { GatedProvider, deferred } = await import("../src/agent/test-providers");
    const gate = deferred();
    const gated = new GatedProvider(
      [
        [{ type: "text_delta", delta: "first" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "text_delta", delta: "second" }, { type: "done", stopReason: "end_turn" }],
      ],
      [gate.promise, null],
    );
    await boot({}, gated);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "steerer");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-steer-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "go" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_started");
    const r = (await c.request(METHODS.sessionSteer, { sessionId: s, text: "wait, actually..." })).result;
    expect(r).toEqual({ ok: true, injected: true });
    const msg = await c.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message" && n.params.clientName === "steer");
    expect(msg.params.text).toBe("wait, actually...");
    gate.resolve();
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.steer with no running turn starts one (injected:false) and emits user_message", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([[
      { type: "text_delta", delta: "sure" },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "steerer-idle");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-steer-idle-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    const r = (await c.request(METHODS.sessionSteer, { sessionId: s, text: "start please" })).result;
    expect(r).toEqual({ ok: true, injected: false });
    const msg = await c.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message" && n.params.clientName === "steer");
    expect(msg.params.text).toBe("start please");
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.steer/interrupt without an engine degrade gracefully", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-engine");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const steer = (await c.request(METHODS.sessionSteer, { sessionId: created.sessionId, text: "hi" })).result;
    expect(steer).toEqual({ ok: true, injected: false });
    const interrupt = (await c.request(METHODS.sessionInterrupt, { sessionId: created.sessionId })).result;
    expect(interrupt).toEqual({ ok: true, wasRunning: false });
    c.close();
  });

  test("session.compact without an engine degrades gracefully", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-engine-compact");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const r = (await c.request(METHODS.sessionCompact, { sessionId: created.sessionId })).result;
    expect(r).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 });
    c.close();
  });

  test("session.compact folds older turns into a checkpoint (over the socket)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "compactor");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-compact-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });

    // 4 turns → 8 messages, past the Compactor's default keepTail(6) → compactable.
    // Sends must be serialized: a turn already running just queues history instead of starting a new one.
    for (let i = 0; i < 4; i++) {
      await c.request(METHODS.sessionSend, { sessionId: s, text: `turn ${i}` });
      const deadline = Date.now() + 2000;
      while (c.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length <= i) {
        if (Date.now() > deadline) throw new Error("timed out waiting for turn_completed");
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const r = (await c.request(METHODS.sessionCompact, { sessionId: s })).result;
    expect(r.ok).toBe(true);
    expect(r.compacted).toBe(true);
    expect(r.uptoSeq).toBeGreaterThan(0);
    expect(r.summaryChars).toBeGreaterThan(0);
    const checkpoint = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "checkpoint");
    expect(checkpoint.params.uptoSeq).toBe(r.uptoSeq);
    expect(checkpoint.params.summary.length).toBe(r.summaryChars);
    c.close();
  });

  test("skills.list returns [] when no skills are installed", async () => {
    await boot(); // no provider → default temp home has no user/project skills
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-skills");
    const { result } = await c.request(METHODS.skillsList, {});
    expect(result).toEqual({ ok: true, skills: [] });
    c.close();
  });

  test("skills.list discovers a user skill over the socket (the daemon wires its one skillStore into the server)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    mkdirSync(join(home, "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Say hi\n---\nSay hello warmly.\n");
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-lister");
    const { result } = await c.request(METHODS.skillsList, {});
    expect(result.ok).toBe(true);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ name: "greet", description: "Say hi", source: "user" });
    c.close();
  });

  test("mcp.list reports a connected MCP server started by the daemon at boot (spawns a real child process)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      mcpServers: { fake: { command: "bun", args: ["run", fixture] } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mcp-lister");
    const { result } = await c.request(METHODS.mcpList, {});
    expect(result).toEqual({ ok: true, servers: [{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }] });
    c.close();
  });

  test("mcp.list({cwd}) ensures + surfaces a trusted project's servers (source \"project\"); mcp.list({}) shows only user servers", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      mcpServers: { fake: { command: "bun", args: ["run", fixture] } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-mcp-project-")));
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", fixture] } } }));

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mcp-lister-project");

    // No cwd: only the user-configured server.
    const noCwd = (await c.request(METHODS.mcpList, {})).result;
    expect(noCwd).toEqual({ ok: true, servers: [{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }] });

    // Untrusted project cwd: ensureProject is a no-op, so the project server is absent.
    const untrusted = (await c.request(METHODS.mcpList, { cwd: projectDir })).result;
    expect(untrusted.servers.find((s: any) => s.name === "proj")).toBeUndefined();

    await c.request(METHODS.trustDir, { path: projectDir });

    // Trusted now: mcp.list starts the project's servers (ensureProject) and shows them.
    const { result } = await c.request(METHODS.mcpList, { cwd: projectDir });
    expect(result.ok).toBe(true);
    expect(result.servers).toContainEqual({ name: "proj", status: "connected", toolNames: ["echo"], source: "project" });
    expect(result.servers).toContainEqual({ name: "fake", status: "connected", toolNames: ["echo"], source: "user" });

    c.close();
  });

  test("plugins.list returns [] when no PluginStore is wired into the server", async () => {
    await boot(); // no `plugins` opt passed by the daemon in this test's boot() helper
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-plugins");
    const { result } = await c.request(METHODS.pluginsList, {});
    expect(result).toEqual({ ok: true, plugins: [] });
    c.close();
  });

  test("plugins.list returns a PluginStore's plugins over the socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-plugins-ipc-"));
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
    const plugins = new PluginStore({ normaHome: home, plugins: { enabled: ["demo"] } });

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins });
    try {
      const c = await TestClient.connect(socketPath);
      await c.hello(tokens.harness, "plugin-lister");
      const { result } = await c.request(METHODS.pluginsList, {});
      expect(result.ok).toBe(true);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]).toMatchObject({
        name: "demo", skills: ["greet"], hasMcp: true, mcpEnabled: true, disabled: false,
      });
      c.close();
    } finally {
      server.stop();
    }
  });

  // THE CONSENT SEAM: a plugin's skills are always live (SkillStore has no consent gate), but a
  // plugin's MCP servers only start when the user has opted in via settings.plugins.enabled —
  // and settings.plugins.disabled always wins over enabled (fully off: no skills, no MCP).
  function seedDemoPlugin(home: string, fixture: string): void {
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "bun", args: ["run", fixture] } } }));
  }

  test("CONSENT: a not-enabled plugin's skills are live but its MCP servers are NOT started", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-off");
    const skills = (await c.request(METHODS.skillsList, {})).result;
    expect(skills.skills.map((s: any) => s.name)).toContain("demo:greet"); // skills always live
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")).toBeUndefined(); // no consent → no server
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: false, disabled: false });
    c.close();
  });

  test("enabled in settings → the plugin's MCP server starts at boot (source plugin)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"] },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-on");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    const st = mcp.servers.find((s: any) => s.name === "demo:fake");
    expect(st?.source).toBe("plugin");
    expect(st?.status).toBe("connected");
    expect(st?.toolNames).toEqual(["echo"]); // tool registered + reachable through the registry
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: true, disabled: false });
    c.close();
  });

  test("disabled beats enabled → plugin fully off (skills gone, MCP not started)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"], disabled: ["demo"] },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-disabled");
    const skills = (await c.request(METHODS.skillsList, {})).result;
    expect(skills.skills.map((s: any) => s.name)).not.toContain("demo:greet");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")).toBeUndefined();
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: false, disabled: true });
    c.close();
  });
});
