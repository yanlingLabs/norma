import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { AgentStore } from "../../src/agent/agents";
import { SubagentManager } from "../../src/agent/subagents";
import type { Provider, ProviderEvent } from "../../src/providers/types";

function setup(
  script: ProviderEvent[][],
  opts: {
    approvalPolicy?: "ask" | "auto" | "plan";
    withSubagents?: boolean; // default true; false → cfg.subagents/agents both omitted
    subagentsOpts?: { maxConcurrent?: number; timeoutMs?: number };
    provider?: Provider; // override — script ignored when set (e.g. a hanging provider for timeout tests)
  } = {},
) {
  const withSubagents = opts.withSubagents !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-spawn-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-spawn-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerAskUserTool(registry);
  registerPlanTool(registry);
  registerSpawnAgentTool(registry);
  const broker = new ApprovalBroker();
  const provider = opts.provider ?? new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const agentsHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = withSubagents ? new AgentStore({ normaHome: agentsHome, trust: agentsTrust }) : undefined;
  const subagents = withSubagents ? new SubagentManager(opts.subagentsOpts ?? {}) : undefined;
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    agents,
    subagents,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs, events };
}

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const spawnCall = (callId: string, prompt: string, extra?: { agentType?: string; model?: string }): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, ...extra }) });

describe("AgentEngine: spawn_agent bridge (1d-iv T5)", () => {
  test("single spawn: fresh child input, thread_started/completed, parent tool_result === child final text", async () => {
    const { engine, store, sessionId, provider } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    expect(started).toMatchObject({ parentThreadId: "main", agentType: "general-purpose", prompt: "do X" });
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(childId).toMatch(/^th_/);

    const completed = events.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" });

    // 3 provider calls: parent round 0 (spawn), the child's one round (index 1), then the
    // parent's own continuation round (index 2, script clamps to the last entry — also
    // "child final report" — ending the parent's turn).
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(3);
    // the child's provider request input is EXACTLY [{message,user,"do X"}] — fresh, not parent history
    expect(fp.requests[1]!.input).toEqual([{ type: "message", role: "user", content: "do X" }]);
  });

  test("two spawn_agent calls in one assistant message: both children run, two thread events, two results", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "task A"), spawnCall("s2", "task B"), done("tool_calls")],
      text("child result"), // reused for both children (FakeProvider clamps to the last script entry)
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const starts = events.filter((e) => e.type === "thread_started");
    expect(starts.length).toBe(2);
    const childIds = new Set(starts.map((e) => (e as Extract<SessionEvent, { type: "thread_started" }>).threadId));
    expect(childIds.size).toBe(2); // distinct thread ids

    const completions = events.filter((e) => e.type === "thread_completed");
    expect(completions.length).toBe(2);

    const r1 = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const r2 = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(r1).toMatchObject({ isError: false, output: "child result" });
    expect(r2).toMatchObject({ isError: false, output: "child result" });
  });

  test("depth>0 spawn (a child trying to spawn) is denied without running the bridge", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")], // parent spawns a child
      [spawnCall("s2", "grandchild"), done("tool_calls")], // the child tries to spawn again (depth 1)
      text("child gave up on spawning further"), // the child's final round after the denial
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // only ONE thread_started/completed pair — the grandchild attempt never ran the bridge
    expect(events.filter((e) => e.type === "thread_started").length).toBe(1);
    expect(events.filter((e) => e.type === "thread_completed").length).toBe(1);

    const denied = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(denied).toMatchObject({ isError: true, output: "subagents cannot spawn further subagents" });
  });

  test("child specs exclude spawn_agent, ask_user, exit_plan_mode", async () => {
    const { provider, engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    const childTools = fp.requests[1]!.tools ?? [];
    const names = childTools.map((t) => t.name);
    expect(names).not.toContain("spawn_agent");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("exit_plan_mode");
    // sanity: the child DOES see ordinary tools (e.g. read/write) — the excludeTools filter is targeted
    expect(names).toContain("write");
  });

  test("policy inheritance: parent in plan mode → child's write tool_call is denied (block message)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")], // parent: spawn_agent allowed even under plan (orchestration)
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child acknowledged the block"),
      ],
      { approvalPolicy: "plan" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawning itself was not blocked

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");
  });

  test("timeout: a SubagentManager with a tiny timeout + a child that never ends → typed error tool_result", async () => {
    class HangOnSecondCall implements Provider {
      readonly id = "fake";
      private call = 0;
      models() { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) {
          // parent round 0: spawns the child
          yield spawnCall("s1", "do X");
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // the CHILD's only round: hangs forever — only the SubagentManager timeout ends this
          await new Promise<never>(() => {});
          return;
        }
        // n >= 2: the parent's OWN continuation round, after the child's timeout tool_result
        // comes back — lets the parent's turn actually finish instead of hanging too.
        yield { type: "text_delta", delta: "done despite child timeout" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], {
      provider: new HangOnSecondCall(),
      subagentsOpts: { timeoutMs: 20 },
    });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("timed out");

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "error" });
  });

  test("cfg.subagents absent → spawn_agent returns the placeholder (no thread events)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("ok"),
      ],
      { withSubagents: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: false });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("subagents are not available in this session");
  });

  test("threadsFor(sessionId) → [main, child...] with parentThreadId + status", async () => {
    const { engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const threads = engine.threadsFor(sessionId);
    expect(threads.length).toBe(2);
    expect(threads[0]).toMatchObject({ threadId: "main" });
    expect(threads[1]).toMatchObject({ parentThreadId: "main", status: "completed", stopReason: "end_turn" });
    expect(threads[1]!.threadId).toMatch(/^th_/);
  });

  test("multi-turn: a child's internal chatter does NOT leak into the 2nd turn's history input (Seam #1 regression)", async () => {
    const { engine, hub, sessionId, provider } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")], // turn 1, parent round 0: spawn
      text("SECRET-CHILD-CHATTER"), // the child's only round — its assistant_message is tagged with the CHILD's threadId, not main
      text("parent turn1 final report"), // turn 1, parent's own continuation round after the child returns
      text("parent turn2 final report"), // turn 2's only round (no spawn this time)
    ]);
    const client = { clientName: "u", deliver: () => true };
    hub.attach(client, sessionId, 0);
    await engine.runTurn(sessionId);
    hub.send(client, sessionId, "second question");
    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    // turn 2's only provider request is the last one recorded
    const req = fp.requests[fp.requests.length - 1]!;
    const asText = JSON.stringify(req.input);
    expect(asText).not.toContain("SECRET-CHILD-CHATTER");
    // sanity: the parent's own turn-1 assistant_message and the new user message ARE present
    expect(asText).toContain("parent turn1 final report");
    expect(asText).toContain("second question");
  });

  test("child-thread deltas carry the child threadId, not main", async () => {
    const { engine, sessionId, events } = setup([
      [spawnCall("c1", "do a thing"), done("tool_calls")],
      text("child-out"),
      text("parent-final"),
    ]);
    await engine.runTurn(sessionId);
    const childDelta = events.find((e) => e.type === "assistant_delta" && e.threadId !== "main");
    expect(childDelta).toMatchObject({ delta: "child-out" });
    const mainDeltas = events.filter((e) => e.type === "assistant_delta" && e.threadId === "main");
    expect(mainDeltas.map((d) => (d as { delta: string }).delta)).toEqual(["parent-final"]);
  });
});
