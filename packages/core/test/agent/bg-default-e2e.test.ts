import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { registerAgentQueryTools } from "../../src/agent/tools/agent-query";
import { setup } from "./engine-spawn.test";

// Phase 5a Task 4: the closing e2e for the 5a pin — proves T2's default flip (a depth-0 spawn with
// `run_in_background` OMITTED now backgrounds by default) and T1's collection tools (agent_list/
// agent_output) combine correctly end to end, through a fake provider, real engine + registry +
// store (no mocks of engine internals). Provider dispatch + poll idiom mirrors
// test/agent/bg-retrigger.test.ts's BgNotifyProvider/WakeTestProvider (content-keyed on
// `req.input[0]`, a session-long main-round counter so one provider instance spans every
// engine.runTurn call in the scenario) — this file reuses that idiom rather than inventing a new
// harness, per the established convention.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => boolean, tries = 400): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await sleep(5);
};

type TaskNotification = Extract<SessionEvent, { type: "task_notification" }>;
const notificationsOf = (events: readonly SessionEvent[]): TaskNotification[] =>
  events.filter((e): e is TaskNotification => e.type === "task_notification");

// Dispatches on `req.input[0]` (bg-retrigger.test.ts's own convention): the detached child's own
// call answers with a fixed reply (its fresh thread input is exactly `[{message,user,"bg task"}]`,
// unambiguous vs. any main-thread round); every other call is the next main-thread round, keyed by
// a session-long counter `n` spanning turn 1 (spawn + wrap-up), turn 2 (the notification's idle
// auto-wake — bg-retrigger Task 2 — reacting by calling agent_output), and turn 3 (manual, driven
// by the test, to prove no duplicate notification).
class BgDefaultCollectProvider implements Provider {
  readonly id = "fake";
  readonly requests: TurnRequest[] = [];
  private mainCall = 0;
  models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    // snapshot NOW (bg-retrigger.test.ts's own precedent): the engine extends the SAME live input
    // array across rounds, so a by-reference push would later show this round's own reply inside
    // its own request's recorded input.
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    const first = req.input[0] as { type?: string; content?: unknown } | undefined;
    if (first?.type === "message" && first.content === "bg task") {
      yield { type: "text_delta", delta: "the answer is 42" };
      yield done("end_turn");
      return;
    }
    const n = this.mainCall++;
    if (n === 0) {
      // turn 1, round 0: spawn_agent with `run_in_background` OMITTED entirely (the actual subject
      // of this test — the 5a default) and named "worker".
      yield {
        type: "tool_call", callId: "s1", name: "spawn_agent",
        argsJson: JSON.stringify({ prompt: "bg task", description: "test task", name: "worker" }),
      };
      yield done("tool_calls");
      return;
    }
    if (n === 1) {
      // turn 1's own continuation round, right after the immediate {agentId,status:"running"}
      // tool_result — ends turn 1 without the parent ever awaiting the detached child.
      yield { type: "text_delta", delta: "turn1 wrap-up" };
      yield done("end_turn");
      return;
    }
    if (n === 2) {
      // turn 2: the notification's idle wake fires this round automatically (bg-retrigger Task 2 —
      // no turn is running once turn 1 already returned) — the model reacts to the notification
      // now in its input by explicitly collecting the full result via agent_output (the "on-demand
      // collection" half of the 5a pin, not just the notification's own embedded <result>).
      yield { type: "tool_call", callId: "ao1", name: "agent_output", argsJson: JSON.stringify({ agent: "worker" }) };
      yield done("tool_calls");
      return;
    }
    if (n === 3) {
      yield { type: "text_delta", delta: "turn2 wrap-up" };
      yield done("end_turn");
      return;
    }
    // n >= 4: turn 3, manually driven by the test — plain wrap-up, no tool calls at all.
    yield { type: "text_delta", delta: "turn3 wrap-up" };
    yield done("end_turn");
  }
}

describe("bg-default spawn -> notification -> agent_output e2e (phase 5a Task 4)", () => {
  test("depth-0 spawn (run_in_background flag omitted, named) backgrounds by default; detached completion persists exactly ONE task_notification; agent_output round-trips the result on a later turn; no duplicate notification and `notified` stays true", async () => {
    const provider = new BgDefaultCollectProvider();
    const { engine, store, sessionId, bgAgents, registry } = setup([], { provider });
    registerAgentQueryTools(registry, { bgAgents, store });

    // turn 1: spawn (flag omitted) -> immediate {agentId,status:"running"} tool_result; the turn
    // wraps up without ever awaiting the detached child.
    await engine.runTurn(sessionId);
    const eventsAfterTurn1 = store.read(sessionId);
    const started = eventsAfterTurn1.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(started).toBeDefined();
    const childId = started.threadId;

    const spawnResult = eventsAfterTurn1.find((e) => e.type === "tool_result" && e.callId === "s1") as Extract<SessionEvent, { type: "tool_result" }>;
    expect(spawnResult).toMatchObject({ isError: false });
    expect(JSON.parse(spawnResult.output)).toEqual({ agentId: childId, status: "running" });

    // the detached child finishes on its own; the completion persists as a task_notification; the
    // idle wake (turn 2) fires by itself and fully settles (bg-retrigger Task 2) before this poll
    // returns — so the assertions below see a STABLE, idle session.
    await waitUntil(() => bgAgents.get(childId)?.status !== "running");
    await waitUntil(() => notificationsOf(store.read(sessionId)).length > 0);
    await waitUntil(() => !engine.isRunning(sessionId));

    expect(bgAgents.get(childId)?.status).toBe("completed");
    expect(bgAgents.get(childId)?.result).toBe("the answer is 42");

    const notesAfterTurn2 = notificationsOf(store.read(sessionId));
    expect(notesAfterTurn2).toHaveLength(1);
    expect(notesAfterTurn2[0]!.content).toContain('Agent "worker" completed');
    expect(notesAfterTurn2[0]!.content).toContain("<result>the answer is 42</result>");
    // exactly-once claim: the detached completion's own settle-time persist claimed the entry.
    expect(bgAgents.get(childId)?.notified).toBe(true);

    // turn 2 (the idle auto-wake): agent_output("worker") returned the terminal result...
    const eventsAfterTurn2 = store.read(sessionId);
    const aoResult = eventsAfterTurn2.find((e) => e.type === "tool_result" && e.callId === "ao1") as Extract<SessionEvent, { type: "tool_result" }>;
    expect(aoResult).toMatchObject({ isError: false, output: "agent 'worker' completed\nthe answer is 42" });
    // ...and did NOT mutate `notified` — agent_output is deliberately READ-ONLY (agent-query.ts's
    // own doc comment: an on-demand peek must never affect a later settle-time claim).
    expect(bgAgents.get(childId)?.notified).toBe(true);

    // turn 3 (manual, driven by the test): still exactly one notification ever — no duplicate is
    // appended for the same completion, whether surfaced via the automatic wake or an ordinary
    // later turn, and `notified` is still true.
    await engine.runTurn(sessionId);
    expect(notificationsOf(store.read(sessionId))).toHaveLength(1);
    expect(bgAgents.get(childId)?.notified).toBe(true);
  });
});
