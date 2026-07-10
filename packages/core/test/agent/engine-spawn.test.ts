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
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerWebTools } from "../../src/agent/tools/web";
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

export function setup(
  script: ProviderEvent[][],
  opts: {
    approvalPolicy?: "ask" | "auto" | "plan";
    withSubagents?: boolean; // default true; false → cfg.subagents/agents both omitted
    subagentsOpts?: { maxConcurrent?: number; timeoutMs?: number };
    provider?: Provider; // override — script ignored when set (e.g. a hanging provider for timeout tests)
    // undefined (default) → EngineConfig.provider.live absent, matching every pre-existing test
    // here (unchanged behavior: every turn uses the "fake-1" boot snapshot below).
    live?: () => { model: string; reasoningEffort?: string };
    // opts.registry lets a caller supply a registry it also registered its own tools onto
    // (e.g. registerToolSearchTool + a deferred tool) BEFORE calling setup — mirrors
    // engine-steer.test.ts's setupEngine `registry` opt. Default: a fresh registry, as before.
    // The standard tool set below is always registered onto whichever registry is used.
    registry?: ToolRegistry;
    // undefined (default) → no deferral anywhere, matching every pre-existing test here
    // (unchanged behavior). Mirrors engine-steer.test.ts's setupEngine `toolSearch` opt.
    toolSearch?: { enabled?: boolean; deferThreshold?: number; deferExternals?: "count" | "always" };
  } = {},
) {
  const withSubagents = opts.withSubagents !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-spawn-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-spawn-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = opts.registry ?? new ToolRegistry();
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
    provider: { provider, model: "fake-1", live: opts.live },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    agents,
    subagents,
    toolSearch: opts.toolSearch,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs, events, registry };
}

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// 4g-ii (CC parity): `description` is now a REQUIRED spawn_agent arg — defaulted here so the
// ~15 pre-existing call sites below (none of which are testing the description contract itself)
// don't all need individual edits; `extra.description` still overrides it (see the "description
// rides thread_started" test below). The dedicated "without description" test constructs its
// tool_call by hand, bypassing this default, to pin the required-arg behavior itself.
const spawnCall = (callId: string, prompt: string, extra?: { agentType?: string; model?: string; description?: string; max_turns?: number; mode?: string }): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "test task", ...extra }) });

describe("AgentEngine: spawn_agent bridge (1d-iv T5)", () => {
  test("spawn_agent without description → invalid args tool_result, no thread_started/completed (schema-required, bridge path)", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X" }) }, done("tool_calls")],
      text("parent noticed the failure and wrapped up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("description");
  });

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
    expect((started as Extract<SessionEvent, { type: "thread_started" }>).description).toBe("test task");

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

  test("spawn description rides thread_started (explicit override wins over the test default)", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "go do the thing", { description: "explore auth module" }), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(started.description).toBe("explore auth module");
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

  // 4e gate fix loop 2 — Defect 1: spawn_agent model override validated against the calling
  // provider's own models() BEFORE thread_started/registerThread/subagents.run (a hallucinated
  // override must fail fast as a typed tool_result, not spawn a child that 404s).
  const TRIO_MODELS = [
    { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
    { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
    { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
  ];

  test("spawn with unknown model override vs a provider whose models() = the 5.6 trio → typed error tool_result, no thread_started, child never runs", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "gpt-5-mini" }), done("tool_calls")],
      text("parent noticed the failure and wrapped up"),
    ];
    const provider = new FakeProvider(script, TRIO_MODELS);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const output = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(output).toContain("gpt-5-mini");
    expect(output).toContain("gpt-5.6-sol");
    expect(output).toContain("gpt-5.6-terra");
    expect(output).toContain("gpt-5.6-luna");

    // No child dispatch at all — only the parent's own two rounds (spawn, then continuation
    // after the typed-error tool_result) hit the provider.
    expect(provider.requests.length).toBe(2);
  });

  test("spawn with a valid model override (in the provider's models()) passes through to the child's TurnRequest.model", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "gpt-5.6-terra" }), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ];
    const provider = new FakeProvider(script, TRIO_MODELS);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(true);
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" });

    expect(provider.requests[1]!.model).toBe("gpt-5.6-terra");
  });

  test("provider with EMPTY models() → an arbitrary spawn model override passes through unchecked", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "totally-made-up-model" }), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ];
    const provider = new FakeProvider(script, []); // e.g. openai-compatible with no static `models` configured
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(true);
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" });

    expect(provider.requests[1]!.model).toBe("totally-made-up-model");
  });

  // 4e gate fix loop 2 — Defect 2: a child whose OWN final round hits a provider error must
  // surface to the parent as an isError tool_result (not the silent "finished without a final
  // message" success), and thread_completed must still carry stopReason "error".
  test("child provider stream error → parent tool_result isError:true with the error message, thread_completed stopReason error", async () => {
    class ErrorOnChildCall implements Provider {
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
          // the child's only round: the provider itself errors (e.g. a 404 on an unknown model)
          yield { type: "error", code: "server", message: "upstream 404: model not found" };
          return;
        }
        // n >= 2: the parent's own continuation round, after the child's isError tool_result
        // comes back — lets the parent's turn actually finish.
        yield { type: "text_delta", delta: "parent wrapped up despite the child's failure" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], { provider: new ErrorOnChildCall() });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "error" });

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("upstream 404: model not found");
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

// -------------------------------------------------------------------------------------------
// Phase 4g whole-branch final-review fix: a spawned child's own ToolSearch load must land in
// THAT child's own `loaded` set (the one its specs()/deferred-guard actually consult), not the
// session-scoped map only the main thread reads. Before the fix, a subagent's ToolSearch-load-
// then-call of a deferred built-in looped (load → guard still rejects → load → ...) to the
// MAX_TOOL_ITERATIONS cap, surfacing to the parent as "subagent … failed: tool-iteration cap
// reached". `web_fetch` (a real deferred:true built-in, `deps.fetchFn` stubbed so no live
// network is hit) stands in for "e.g. web_fetch" from the finding — the same class of bug would
// hit any deferred built-in or mcp__ tool a child tries to ToolSearch-load.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: subagent ToolSearch-load-then-call (4g final-review fix)", () => {
  function buildWebDeferredRegistry(): { registry: ToolRegistry; fetchCalls: string[] } {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("<html><body><h1>Hi from the fake page</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    registerWebTools(registry, { fetchFn: fakeFetch });
    return { registry, fetchCalls };
  }

  test("a spawned child can ToolSearch-load a deferred built-in and call it in the SAME child turn — no iteration-cap failure", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "fetch the page"), done("tool_calls")], // parent round 0: spawn
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")], // child round 0: load
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")], // child round 1: call it
      text("child fetched the page"), // child round 2: end turn
      text("parent wrap-up"), // parent's continuation round, after the child's tool_result
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {} });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // The deferred tool actually ran — proof the child's OWN follow-up call was accepted, not
    // rejected-then-looped-to-the-cap (the pre-fix bug: the load landed in the session map, which
    // the child's own guard never consults).
    expect(fetchCalls).toEqual(["https://example.com/page"]);
    const callResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(callResult).toMatchObject({ isError: false });
    expect((callResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Fetched https://example.com/page");

    // The child's own thread ended normally (not the iteration-cap typed error).
    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    // The parent sees the child's real final text, not a "subagent … failed: tool-iteration cap
    // reached" typed error.
    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false, output: "child fetched the page" });

    // The parent's own turn completed normally.
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });
  });

  test("a child's ToolSearch load does not leak into the session/main-thread loaded set: the SAME tool called unloaded from main is still rejected", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "fetch the page"), done("tool_calls")], // parent round 0: spawn
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")], // child round 0: load
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")], // child round 1: call it
      text("child fetched the page"), // child round 2: end turn
      // parent's continuation round: calls the SAME tool directly, unloaded on the main thread —
      // must still be rejected if the child's earlier load didn't leak into the session set.
      [{ type: "tool_call", callId: "p1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/other" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {} });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const parentCallResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(parentCallResult).toMatchObject({ isError: true });
    expect((parentCallResult as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toContain("deferred — load its schema via ToolSearch first");
    // Only the CHILD's call actually reached the network stub — the parent's unloaded attempt
    // was rejected before executeCall ever ran.
    expect(fetchCalls).toEqual(["https://example.com/page"]);
  });

  test("main-thread ToolSearch load path is unchanged: a plain (non-subagent) load-then-call still works", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")],
      text("fetched it"),
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {}, withSubagents: false });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(fetchCalls).toEqual(["https://example.com/page"]);
    const callResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(callResult).toMatchObject({ isError: false });
    const turnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(turnCompleted).toMatchObject({ stopReason: "end_turn" });
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-i: spawn_agent's `max_turns` — a per-child cap on the tool-iteration loop (CC parity
// with Agent.max_turns). Only the spawn bridge ever passes this; main-thread turns are unaffected.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent max_turns (4h-i)", () => {
  const loopingToolCall = (callId: string): ProviderEvent =>
    ({ type: "tool_call", callId, name: "glob", argsJson: '{"pattern":"*"}' });

  test("max_turns: 2 caps the child at exactly 2 iterations — parent sees the cap message as an isError tool_result", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever", { max_turns: 2 }), done("tool_calls")], // parent round 0: spawn
      [loopingToolCall("loop0"), done("tool_calls")], // child iteration 0
      [loopingToolCall("loop1"), done("tool_calls")], // child iteration 1 — bound reached, cap fires
      text("parent wrap-up"), // parent's continuation round, after the child's isError tool_result
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (2) reached" });

    const completed = events.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "error" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({
      isError: true,
      output: "subagent (general-purpose) failed: tool-iteration cap (2) reached",
    });

    // The parent's own turn still completes normally — an isError tool_result doesn't itself end
    // the turn (only a human denial does); the parent just sees it and continues.
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });

    // 4 provider calls: parent round 0 (spawn), the child's 2 capped iterations, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(4);
  });

  test("no max_turns → child still uses the default cap (24), unchanged from before this feature", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever"), done("tool_calls")], // parent round 0: spawn, no max_turns
      ...Array.from({ length: 24 }, (_, i): ProviderEvent[] => [loopingToolCall(`loop${i}`), done("tool_calls")]),
      text("parent wrap-up"), // parent's continuation round, after the child's isError tool_result
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (24) reached" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({
      isError: true,
      output: "subagent (general-purpose) failed: tool-iteration cap (24) reached",
    });

    // 26 provider calls: parent round 0 (spawn), the child's 24 capped iterations, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(26);
  });

  test("max_turns: 1 — the tight boundary caps after exactly 1 iteration", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever", { max_turns: 1 }), done("tool_calls")], // parent round 0: spawn
      [loopingToolCall("loop0"), done("tool_calls")], // child iteration 0 — bound reached, cap fires
      text("parent wrap-up"), // parent's continuation round
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (1) reached" });

    // 3 provider calls: parent round 0 (spawn), the child's single capped iteration, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(3);
  });

  // The bridge hand-parses raw argsJson BEFORE spawn.ts's own zod validation would ever run (a
  // provider could send an out-of-schema value even though the declared arg is
  // `.int().positive().max(50)`) — the guard must IGNORE an invalid value, not pass it through
  // as-is. A bug here (e.g. clamping a negative number up to 1 instead of ignoring it, or worse,
  // leaving it negative/zero) would make the loop bound `iteration < 0` — the child would hit the
  // cap message WITHOUT ever calling the provider. This pins that it's ignored (falls back to the
  // default 24), not misapplied.
  test("invalid max_turns (non-positive) is ignored — not passed through as a 0/negative bound", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { max_turns: -5 }), done("tool_calls")], // parent round 0: spawn, invalid max_turns
      text("child final report"), // child round 0: completes normally — proves the bound wasn't clamped to <= 0
      text("parent wrap-up"), // parent's continuation round
    ];
    const { engine, store, sessionId } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false, output: "child final report" });
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-i Task 2: spawn_agent's `mode` — a RESTRICT-ONLY child permission-mode override (CC
// parity with Agent's permission-mode arg). A child may run NARROWER than its parent, NEVER
// wider — see restrictPolicy/mapSpawnMode's own unit tests (spawn-mode-policy.test.ts) for the
// pure min-permissiveness logic itself. These engine tests pin the end-to-end wiring: the bridge
// actually applies the narrowed policy to the CHILD's own runThread, and never mutates the
// parent's shared `meta` object.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent mode (restrict-only, 4h-i Task 2)", () => {
  test("mode: 'plan' narrows a parent-'auto' child to plan policy — the child's write tool_call is gate-denied (Blocked in plan mode)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X", { mode: "plan" }), done("tool_calls")], // parent policy "auto"; mode narrows the child to "plan"
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child acknowledged the block"),
      ],
      { approvalPolicy: "auto" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawning itself is never blocked (read-only/orchestration)

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");

    // sanity: the PARENT's own session policy is untouched by the child's narrowed mode
    expect(store.meta(sessionId).approvalPolicy).toBe("auto");
  });

  test("mode: 'bypassPermissions' from a parent-'ask' session is an ESCALATION — denied; the child's write still requires human approval, is not auto-allowed", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { mode: "bypassPermissions" }), done("tool_calls")], // parent policy "ask"
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
      text("child acknowledged the denial"),
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId, hub, broker } = setup(script, { approvalPolicy: "ask" });
    const watcher = {
      clientName: "auto-denier",
      deliver: (e: SessionEvent) => { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawn_agent itself is read-only, always allowed

    // The child's write call REQUIRED approval — proof the "bypassPermissions" (→ Norma "auto")
    // escalation was denied and the child stayed at the parent's "ask" policy. If the escalation
    // had gone through, this would have been an auto-allow with NO approval_requested at all.
    const approvalReq = events.find((e) => e.type === "approval_requested" && e.callId === "w1");
    expect(approvalReq).toBeDefined();
    expect(events.find((e) => e.type === "approval_resolved" && e.callId === "w1")).toMatchObject({ approved: false, by: "auto-denier" });

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });

    // sanity: the PARENT's own session policy is untouched by the denied escalation attempt
    expect(store.meta(sessionId).approvalPolicy).toBe("ask");
  });

  test("no mode → child inherits the parent's policy exactly, and the spawn NEVER mutates the shared parent meta (a same-turn parent write still follows the original 'ask' policy)", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent round 0: spawn, no mode at all
      text("child final report"), // the child's only round
      // the parent's OWN continuation round makes its OWN write call — must still be gated under
      // the session's ORIGINAL "ask" policy; if the spawn bridge had mutated the shared `meta`
      // object (e.g. widened it while building childMeta), this call would see the corruption.
      [{ type: "tool_call", callId: "p1", name: "write", argsJson: JSON.stringify({ path: "after.txt", content: "z" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId, hub, broker } = setup(script, { approvalPolicy: "ask" });
    const watcher = {
      clientName: "auto-approver",
      deliver: (e: SessionEvent) => { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false, output: "child final report" });

    // the parent's post-spawn write still went through the normal "ask" approval flow
    const approvalReq = events.find((e) => e.type === "approval_requested" && e.callId === "p1");
    expect(approvalReq).toBeDefined();
    const p1Result = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(p1Result).toMatchObject({ isError: false }); // approved

    // the session's persisted policy is untouched (only enter/exit_plan_mode ever calls setPolicy)
    expect(store.meta(sessionId).approvalPolicy).toBe("ask");
  });

  test("mode: 'default' behaves exactly like an absent mode — no override, child inherits the parent's 'auto' policy (a child write is NOT blocked)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X", { mode: "default" }), done("tool_calls")],
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child wrote the file"),
      ],
      { approvalPolicy: "auto" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
  });
});
