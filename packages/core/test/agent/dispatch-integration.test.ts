import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSessionSpawnTool } from "../../src/agent/tools/session-spawn";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { DispatchChildren } from "../../src/agent/dispatch-children";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { stubRegistry, stubReviewer } from "./engine-reviewer.test";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";

// Task 9 (Dispatch mode, Phase 7): the end-to-end integration test — a real AgentEngine + real
// SessionStore/SessionHub (temp NORMA_HOME) + a REAL DispatchChildren registry, all wired exactly
// like daemon.ts wires them (see setup() below), driven by a single scripted provider shared by
// BOTH the dispatch session's own turns and its children's turns (same "one engine, one provider"
// harness shape as session-spawn.test.ts/dispatch-relay.test.ts).
//
// Ordering hazard this file has to design around: `DispatchChildren.spawnChild` kicks off a
// child's turn via `void this.deps.runTurn(childId)` — fire-and-forget, genuinely concurrent with
// the dispatch session's OWN turn loop (unlike spawn_agent's children, which the engine `await`s
// via `Promise.all` before continuing). A plain index-based scripted provider (`FakeProvider`,
// used elsewhere) can't safely tell the dispatch session's own follow-up round apart from the
// child's own first round when both may call the SAME shared provider in either order — so this
// file uses `RoutedProvider` below, which picks its response by INSPECTING each request's `input`
// (a child's own history always carries its exact opening prompt as a `message` item, every round;
// the dispatch session's own history never does) rather than by call order. This makes every
// scenario's outcome deterministic regardless of real microtask interleaving.
//
// This test also exercises a Task 9 fix in engine.ts/dispatch-children.ts: a session_spawn call's
// `child_update` ("running") used to be appended to the dispatch stream INSIDE `spawnChild` itself,
// which ran (synchronously) BEFORE that same call's own tool_call/tool_result were emitted — so the
// dispatch stream read child_update(running) before the tool_call that caused it. `spawnChild` no
// longer appends that event; the engine now calls the new `DispatchChildren.announceChild` right
// after emitting session_spawn's own tool_result (see engine.ts's `spawnedChildIds` map and
// dispatch-children.ts's `announceChild` doc comments). Scenario A's ordering assertion pins this.

const FAKE_MODELS: ModelInfo[] = [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }];

/** Scripted provider whose response is chosen by INSPECTING the request, not by call order — see
 *  this file's header comment for why plain call-order scripting isn't safe here. `respond` may
 *  return a plain array (the common case) or a Promise that never resolves (scenario C's hung
 *  child turn, so a completed child can never race the dispatch session's own second turn). */
class RoutedProvider implements Provider {
  readonly id = "fake";
  readonly requests: TurnRequest[] = [];
  constructor(
    private readonly respond: (req: TurnRequest) => ProviderEvent[] | Promise<ProviderEvent[]>,
    private readonly modelInfos: ModelInfo[] = FAKE_MODELS,
  ) {}
  models(): ModelInfo[] { return this.modelInfos; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    const events = await this.respond(req);
    for (const e of events) yield e;
  }
}

/** True for a request that belongs to the CHILD session's own turn: a child's opening user message
 *  (its `prompt`) is replayed as history in EVERY round of its own turn, and the dispatch session's
 *  own history never contains that exact string (it only ever sees the child's title/dir/status via
 *  the roster reminder, and the prompt re-encoded as JSON inside the session_spawn tool_call's own
 *  argsJson — never as a bare `message` item). */
function isChildRound(req: TurnRequest, childPrompt: string): boolean {
  return req.input.some((i) => i.type === "message" && i.role === "user" && i.content === childPrompt);
}

const finish = (text: string): ProviderEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", inputTokens: 5, outputTokens: 2 },
  { type: "done", stopReason: "end_turn" },
];
const spawnCallEvents = (dir: string, prompt: string, title: string, callId = "c1"): ProviderEvent[] => [
  { type: "tool_call", callId, name: "session_spawn", argsJson: JSON.stringify({ dir, prompt, title }) },
  { type: "done", stopReason: "tool_calls" },
];

/** Polls a synchronous predicate until it's true or the deadline passes — no fixed sleep is ever
 *  the sole synchronization here; every await below is gated on an observable outcome (an event
 *  landing in the store, a spy's call count). Mirrors routines/e2e.test.ts's own `waitUntil`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
}

/** Wires one AgentEngine + one DispatchChildren exactly like daemon.ts does (store/hub/registry,
 *  `dispatch`/`onTurnEnd`/`dispatchRoster` getters closing over the SAME `dispatchChildren`
 *  binding, `dispatchChildren.start()` called once, immediately, before any turn ever runs — so,
 *  unlike this file's own unit-test siblings, `start()` here can never clobber a live child: no
 *  spawn happens before it). `opts.registry` lets a scenario hand in a registry that already has
 *  extra tools registered (scenario B's stub bash) — session_spawn/task_stop are ALWAYS added on
 *  top of whatever's passed in, mirroring daemon.ts registering every tool onto one shared registry. */
function setup(
  provider: Provider,
  opts: { registry?: ToolRegistry; reviewer?: unknown } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-integration-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-integration-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = opts.registry ?? new ToolRegistry();
  registerSessionSpawnTool(registry);
  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-integration-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  let dispatchChildren: DispatchChildren | undefined;
  const engine: AgentEngine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    reviewer: opts.reviewer as never,
    dispatch: () => dispatchChildren,
    onTurnEnd: (sid) => dispatchChildren?.onTurnEnd(sid),
    dispatchRoster: (sid) => dispatchChildren?.rosterFor(sid),
  });
  dispatchChildren = new DispatchChildren({
    store, hub,
    runTurn: (sid) => engine.runTurn(sid),
    isRunning: (sid) => engine.isRunning(sid),
    interrupt: (sid) => { engine.interrupt(sid); },
  });
  dispatchChildren.start();
  registerTaskStopTool(registry, { dispatch: { stopChild: (caller, id) => dispatchChildren?.stopChild(caller, id) } });

  const dispatchId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: "dispatch" });
  return { engine, store, hub, broker, dispatchId };
}

describe("Task 9: dispatch mode end-to-end integration", () => {
  test("scenario A: spawn -> child completes -> dispatch wakes with the roster reminder in its input", async () => {
    const CHILD_PROMPT = "do the thing";
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-integration-childA-")));
    let dispatchCallCount = 0;
    const provider = new RoutedProvider((req) => {
      if (isChildRound(req, CHILD_PROMPT)) return finish("did the thing");
      dispatchCallCount++;
      if (dispatchCallCount === 1) return spawnCallEvents(childDir, CHILD_PROMPT, "Thing");
      return finish("ok");
    });
    const { engine, store, dispatchId } = setup(provider);
    const runTurnSpy = spyOn(engine, "runTurn");

    await engine.runTurn(dispatchId); // Turn 1: round0 (session_spawn) + round1 (closes turn 1)

    // Wait for the woken SECOND dispatch turn to fully settle (implies the child already completed
    // and the wake already fired — whichever of the two possible wake paths, immediate or
    // coalesced-on-turn-end, actually happened).
    await waitUntil(() => store.read(dispatchId, 0).filter((e) => e.type === "turn_completed").length >= 2);

    const events = store.read(dispatchId, 0);
    // 1) dispatch stream order: tool_call(session_spawn) -> tool_result(contains child id) ->
    //    child_update(running) -> child_update(completed, resultSummary "did the thing").
    const idxToolCall = events.findIndex((e) => e.type === "tool_call" && (e as { name: string }).name === "session_spawn");
    const idxToolResult = events.findIndex((e) => e.type === "tool_result" && (e as { callId: string }).callId === "c1");
    const idxRunning = events.findIndex((e) => e.type === "child_update" && (e as { status: string }).status === "running");
    const idxCompleted = events.findIndex((e) => e.type === "child_update" && (e as { status: string }).status === "completed");
    expect(idxToolCall).toBeGreaterThanOrEqual(0);
    expect(idxToolResult).toBeGreaterThan(idxToolCall);
    expect(idxRunning).toBeGreaterThan(idxToolResult);
    expect(idxCompleted).toBeGreaterThan(idxRunning);

    const childId = (events[idxRunning] as { childSessionId: string }).childSessionId;
    expect(childId.length).toBeGreaterThan(0);
    expect((events[idxToolResult] as { output: string }).output).toContain(childId);
    expect((events[idxCompleted] as { childSessionId: string; resultSummary?: string }).childSessionId).toBe(childId);
    expect((events[idxCompleted] as { resultSummary?: string }).resultSummary).toBe("did the thing");

    // 2) dispatch got woken: a second dispatch turn ran (engine.runTurn(dispatchId) called twice —
    //    once explicitly by this test, once internally by the wake).
    expect(runTurnSpy.mock.calls.filter((c) => c[0] === dispatchId).length).toBe(2);

    // 3) roster reminder appeared in the woken turn's own input (the 3rd dispatch-attributed
    //    request: round0 spawn, round1 closes turn 1, round2 is the woken turn's only round).
    const dispatchRequests = provider.requests.filter((r) => !isChildRound(r, CHILD_PROMPT));
    expect(dispatchRequests.length).toBe(3);
    const wokenTurnRequest = dispatchRequests[2]!;
    const hasRoster = wokenTurnRequest.input.some(
      (i) => i.type === "message" && i.role === "user" && typeof i.content === "string" && i.content.includes("Dispatch children roster"),
    );
    expect(hasRoster).toBe(true);
  });

  test("scenario B: a child's reviewer-escalated bash approval relays into the dispatch stream and back", async () => {
    const CHILD_PROMPT = "do the thing";
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-integration-childB-")));
    const { registry: sharedRegistry, calls: bashCalls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "looks risky" });

    let dispatchCallCount = 0;
    const provider = new RoutedProvider((req) => {
      if (isChildRound(req, CHILD_PROMPT)) {
        const hasBashResult = req.input.some((i) => i.type === "tool_result" && i.callId === "c_bash");
        if (!hasBashResult) {
          return [
            { type: "tool_call", callId: "c_bash", name: "bash", argsJson: JSON.stringify({ command: "rm -rf /tmp/scenario-b-target" }) },
            { type: "done", stopReason: "tool_calls" },
          ];
        }
        return finish("cleaned up");
      }
      dispatchCallCount++;
      if (dispatchCallCount === 1) return spawnCallEvents(childDir, CHILD_PROMPT, "Thing");
      return finish("ok");
    });

    const { engine, store, broker, dispatchId } = setup(provider, { registry: sharedRegistry, reviewer });

    await engine.runTurn(dispatchId); // Turn 1: spawns the child; the child's bash call escalates in the background

    // Poll for the mirrored approval_requested — the child's own turn is fire-and-forget, so it may
    // land before, during, or after Turn 1's own closing round.
    await waitUntil(() => store.read(dispatchId, 0).some((e) => e.type === "approval_requested"));
    const requested = store.read(dispatchId, 0).find((e) => e.type === "approval_requested") as {
      childSessionId: string; toolName: string;
    };
    const childId = requested.childSessionId;
    expect(childId.length).toBeGreaterThan(0);
    expect(requested.toolName).toBe("bash");

    broker.resolve(childId, "c_bash", true, "test-approver");

    await waitUntil(() => {
      const es = store.read(dispatchId, 0);
      return es.some((e) => e.type === "approval_resolved")
        && es.some((e) => e.type === "child_update" && (e as { childSessionId: string }).childSessionId === childId && (e as { status: string }).status === "completed");
    });

    const events = store.read(dispatchId, 0);
    const resolved = events.find((e) => e.type === "approval_resolved");
    expect(resolved).toMatchObject({ childSessionId: childId, approved: true, by: "test-approver" });

    const completedUpdate = events.find(
      (e) => e.type === "child_update" && (e as { childSessionId: string }).childSessionId === childId && (e as { status: string }).status === "completed",
    ) as { resultSummary?: string };
    expect(completedUpdate.resultSummary).toBe("cleaned up");
    expect(bashCalls.some((c) => c.command === "rm -rf /tmp/scenario-b-target")).toBe(true);
  });

  test("scenario C: task_stop from the dispatch session interrupts the child and confirms in its tool_result", async () => {
    const CHILD_PROMPT = "do the thing";
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-integration-childC-")));
    let dispatchCallCount = 0;
    let childId: string | undefined;
    const provider = new RoutedProvider((req) => {
      // The child's turn HANGS forever (never resolves) — this scenario stops a genuinely still-
      // running child, and a completed child could otherwise race the dispatch session's second
      // explicit turn below (see this file's header comment on the fire-and-forget hazard).
      if (isChildRound(req, CHILD_PROMPT)) return new Promise<ProviderEvent[]>(() => {});
      dispatchCallCount++;
      if (dispatchCallCount === 1) return spawnCallEvents(childDir, CHILD_PROMPT, "Thing");
      if (dispatchCallCount === 2) return finish("ok"); // closes Turn 1
      if (dispatchCallCount === 3) {
        return [
          { type: "tool_call", callId: "c_stop", name: "task_stop", argsJson: JSON.stringify({ task_id: childId }) },
          { type: "done", stopReason: "tool_calls" },
        ];
      }
      return finish("stopped"); // closes Turn 2
    });
    const { engine, store, dispatchId } = setup(provider);
    const interruptSpy = spyOn(engine, "interrupt");

    await engine.runTurn(dispatchId); // Turn 1: spawns the (permanently hung) child

    const runningUpdate = store.read(dispatchId, 0).find(
      (e) => e.type === "child_update" && (e as { status: string }).status === "running",
    ) as { childSessionId: string };
    childId = runningUpdate.childSessionId;
    expect(childId.length).toBeGreaterThan(0);

    await engine.runTurn(dispatchId); // Turn 2: task_stop(childId)

    expect(interruptSpy).toHaveBeenCalledWith(childId);
    expect(interruptSpy.mock.calls.filter((c) => c[0] === childId).length).toBe(1);

    const toolResult = store.read(dispatchId, 0).find(
      (e) => e.type === "tool_result" && (e as { callId: string }).callId === "c_stop",
    ) as { isError: boolean; output: string };
    expect(toolResult).toBeDefined();
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toContain(childId);
    expect(toolResult.output.toLowerCase()).toContain("stopped");
  });
});
