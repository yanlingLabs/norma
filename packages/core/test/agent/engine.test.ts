import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerRequestDirTool } from "../../src/agent/tools/request-dir";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

function setup(script: ProviderEvent[][], policy: "ask" | "auto" = "auto", extraRoots: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd, ...extraRoots]);
  registerRequestDirTool(registry, {
    broker,
    dirs,
    emit: (sid, e) => hub.append(sid, e), // matches production wiring (daemon.ts)
    projectDir: () => null,
    approvalTimeoutMs: 500,
  });
  // Default assembler — these tests don't exercise context assembly (see engine-context.test.ts).
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  // Default compactor — these tests don't exercise compaction (see engine-compaction.test.ts).
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: policy });
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

function types(events: SessionEvent[]): string[] { return events.map((e) => e.type); }

describe("AgentEngine", () => {
  test("simple text turn: turn_started, assistant_message, turn_completed", async () => {
    const { engine, store, sessionId } = setup([text("hello there")]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(["session_created", "turn_started", "assistant_message", "turn_completed"]);
    expect(events.find((e) => e.type === "assistant_message")).toMatchObject({ text: "hello there", threadId: "main" });
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "end_turn", inputTokens: 10, outputTokens: 2 });
  });

  test("tool round-trip: model calls write, engine executes (auto policy) and loops to completion", async () => {
    const { engine, store, sessionId, cwd, provider } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"hello.txt","content":"norma was here"}' }, done("tool_calls")],
      text("wrote it!"),
    ]);
    await engine.runTurn(sessionId);
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("norma was here");
    const events = store.read(sessionId);
    expect(types(events)).toEqual([
      "session_created", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed",
    ]);
    // second provider call got the call + result in its input:
    const second = provider.requests[1]!;
    expect(second.input.some((i) => i.type === "function_call" && i.callId === "c1")).toBe(true);
    expect(second.input.some((i) => i.type === "tool_result" && i.callId === "c1")).toBe(true);
  });

  test("ask policy: approval_requested is appended; denial produces an error tool_result", async () => {
    const { engine, store, hub, broker, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"x.txt","content":"y"}' }, done("tool_calls")],
      text("ok, not writing"),
    ], "ask");
    // watcher answers the approval as soon as it sees it:
    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(expect.arrayContaining(["approval_requested", "approval_resolved", "tool_result"]));
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "auto-denier" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect((events.find((e) => e.type === "tool_result") as any).output).toMatch(/denied/);
  });

  test("approval timeout auto-denies", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "edit", argsJson: '{"path":"a","old_string":"x","new_string":"y"}' }, done("tool_calls")],
      text("gave up"),
    ], "ask");
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });
  });

  test("provider error yields agent_error + turn_completed(error)", async () => {
    const { engine, store, sessionId } = setup([[{ type: "error", code: "auth", message: "not signed in — run: norma login" }]]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(["session_created", "turn_started", "agent_error", "turn_completed"]);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
  });

  test("history: prior user/assistant messages are included as input", async () => {
    const { engine, store, hub, sessionId, provider } = setup([text("first"), text("second")]);
    const client: HubClient = { clientName: "u", deliver() { return true; } };
    hub.attach(client, sessionId, 0);
    hub.send(client, sessionId, "question one");
    await engine.runTurn(sessionId);
    hub.send(client, sessionId, "question two");
    await engine.runTurn(sessionId);
    const req = provider.requests[1]!;
    const messages = req.input.filter((i) => i.type === "message");
    expect(messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "question one"],
      ["assistant", "first"],
      ["user", "question two"],
    ]);
  });

  test("concurrent runTurn on the same session is refused (one turn at a time)", async () => {
    const { engine, sessionId } = setup([text("slow")]);
    const first = engine.runTurn(sessionId);
    await expect(engine.runTurn(sessionId)).rejects.toThrow(/turn already running/);
    await first;
  });

  test("tool-iteration cap ends the turn with agent_error", async () => {
    const looping: ProviderEvent[] = [
      { type: "tool_call", callId: "loop", name: "glob", argsJson: '{"pattern":"*"}' },
      { type: "done", stopReason: "tool_calls" },
    ];
    const { engine, store, sessionId } = setup([looping]); // script repeats: same entry every iteration
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "agent_error" && (e as any).message.includes("iteration cap"))).toBe(true);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
  });

  test("engine threads allowed roots into tools; write in an additional root succeeds", async () => {
    const extraRoot = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-extra-")));
    const target = join(extraRoot, "in-extra.txt");
    const { engine, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "norma was here" }) }, done("tool_calls")],
      text("wrote it!"),
    ], "auto", [extraRoot]);
    await engine.runTurn(sessionId);
    expect(readFileSync(target, "utf8")).toBe("norma was here");
  });

  test("a turn on a cwd-less session fails closed (no fallback to daemon cwd)", async () => {
    const { engine, store } = setup([text("should not run")]);
    const sessionId = store.createSession("global"); // no cwd, default policy
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "agent_error" && (e as any).message.includes("working directory"))).toBe(true);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  test("request_directory self-gates: exactly one approval_requested (not a gate prompt plus the tool's own), and approving it grants the dir", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outside-")));
    const { engine, store, hub, broker, sessionId, dirs } = setup([
      [{ type: "tool_call", callId: "c1", name: "request_directory", argsJson: JSON.stringify({ path: outsideDir }) }, done("tool_calls")],
      text("granted"),
    ], "ask"); // "ask" policy: if the gate still double-prompted request_directory, this is where it would show up
    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const approvalRequests = events.filter((e) => e.type === "approval_requested");
    expect(approvalRequests.length).toBe(1); // one prompt, not two (no engine-level gate prompt + the tool's own)
    expect(approvalRequests[0]).toMatchObject({ toolName: "request_directory" });
    expect(dirs.has(sessionId, outsideDir)).toBe(true);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: false });
  });
});
