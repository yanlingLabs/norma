import { describe, expect, test } from "bun:test";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import type { SessionEvent } from "@norma/protocol";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { setup } from "./engine-spawn.test";

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// A fresh spawn with a stable `name` so a later turn can address it by name for resume (the model
// can't know the generated agentId in advance; `name` is the stable handle — 4h-ii-b Task 2).
const spawnNamed = (callId: string, prompt: string, name: string, extra?: Record<string, unknown>): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "task", name, ...extra }) });
// A resume: `resume` + a NEW `prompt`, and DELIBERATELY no `description` — resume sits before the
// bridge's description check (D7), so it must succeed without one.
const resumeCall = (callId: string, resume: string, prompt: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ resume, prompt }) });

const M = (role: "user" | "assistant", content: string): { type: "message"; role: "user" | "assistant"; content: string } =>
  ({ type: "message", role, content });
const lastUserOf = (input: readonly unknown[]): string | undefined => {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: string; role?: string; content?: unknown };
    if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
  }
  return undefined;
};
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};

// childHistoryInput is private, tested the same way buildInstructionsFull is (see
// engine-runthread.test.ts): cast to `any` and call directly, with the store seeded by hand
// (mirrors engine-compaction.test.ts's own `store.append` seeding for historyInput). This is the
// foundation for `resume` (4h-ii-b Task 3) — reconstructs a SPECIFIC child thread's own history
// from the store, in seq order, INCLUDING its tool_call/tool_result pairs — unlike historyInput,
// which only ever replays user/assistant MESSAGES for the MAIN thread (a resumed child has no
// assistant-text summary to fall back on for what its tools did — see childHistoryInput's own doc
// comment in engine.ts for the full reasoning).
describe("engine: childHistoryInput (4h-ii-b Task 1 — per-child thread history reconstruction)", () => {
  test("reconstructs a child thread's own user/assistant/tool_call/tool_result events, in seq order, with the exact TurnInputItem shapes runThread's own dispatch loop uses", () => {
    const provider = new FakeProvider([]);
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "th_child", text: "do the task", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_child", text: "on it" });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "th_child", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "th_child", callId: "c1", output: "file contents", isError: false });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_child", text: "done, here's the report" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (engine as any).childHistoryInput(sessionId, "th_child");

    expect(input).toEqual([
      { type: "message", role: "user", content: "do the task" },
      { type: "message", role: "assistant", content: "on it" },
      { type: "function_call", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' },
      { type: "tool_result", callId: "c1", output: "file contents", isError: false },
      { type: "message", role: "assistant", content: "done, here's the report" },
    ]);
  });

  test("excludes OTHER threads' events — main thread + a sibling child thread are both filtered out, interleaved seq or not", () => {
    const provider = new FakeProvider([]);
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "main prompt", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "main reply" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_sibling", text: "sibling chatter" });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "th_sibling", callId: "s1", name: "glob", argsJson: "{}" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_target", text: "target's own message" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "main wraps up" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (engine as any).childHistoryInput(sessionId, "th_target");

    expect(input).toEqual([{ type: "message", role: "assistant", content: "target's own message" }]);
  });

  test("unknown/never-spawned threadId → empty array, no throw", () => {
    const provider = new FakeProvider([]);
    const { engine, store, sessionId } = setupEngine(provider);
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_a", text: "hi" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (engine as any).childHistoryInput(sessionId, "th_nonexistent");
    expect(input).toEqual([]);
  });

  test("a failed tool_result (isError:true) round-trips isError, not silently dropped/coerced", () => {
    const provider = new FakeProvider([]);
    const { engine, store, sessionId } = setupEngine(provider);
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "th_a", callId: "c1", name: "bash", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "th_a", callId: "c1", output: "command not found", isError: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (engine as any).childHistoryInput(sessionId, "th_a");
    expect(input).toEqual([
      { type: "function_call", callId: "c1", name: "bash", argsJson: "{}" },
      { type: "tool_result", callId: "c1", output: "command not found", isError: true },
    ]);
  });
});

// -------------------------------------------------------------------------------------------
// 4h-ii-b Task 3: spawn_agent `resume` — continue a FINISHED child WITH its full prior context
// (its own message + tool history), re-running the SAME child thread rather than spawning a fresh
// one. The centerpiece of "resume it with a follow-up — it remembers".
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent resume (4h-ii-b Task 3)", () => {
  // Step 1(a): a resumed run re-runs the SAME threadId with input = [prior history + the new
  // prompt] — proving BOTH the prior exchange AND the new instruction are carried.
  test("(a) resume carries the child's prior exchange AND the new prompt into the SAME thread's input", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1 round 0: spawn
      text("child-out-1"),                                             // child run 1
      text("parent turn1"),                                           // main continuation
      [resumeCall("r1", "worker", "now do Y"), done("tool_calls")],    // turn 2 round 0: resume
      text("child-out-2"),                                           // resumed child run
      text("parent turn2"),                                          // main continuation
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn "worker" (sync) → completes + registers
    await engine.runTurn(sessionId); // turn 2: resume "worker" with "now do Y"

    const fp = provider as FakeProvider;
    // exactly 6 provider calls (3 per turn) — guards FakeProvider's silent last-entry clamp
    expect(fp.requests.length).toBe(6);

    // find the RESUMED child's own provider request by content (opening + last-user = new prompt),
    // never by hard index — immune to any round miscount
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "now do Y");
    expect(resumed).toBeDefined();
    expect(resumed!.input).toEqual([
      M("user", "do the task"),      // opening prompt, prepended (never persisted by the fresh spawn)
      M("assistant", "child-out-1"), // the child's OWN prior reply, reconstructed from the store
      M("user", "now do Y"),         // the new instruction, persisted then picked up last
    ]);

    // the resume re-ran the SAME thread (one child thread across both turns), not a fresh one
    const worker = bgAgents.get("worker", sessionId)!;
    const childStarts = store.read(sessionId).filter((e) => e.type === "thread_started" && e.threadId === worker.threadId);
    expect(childStarts.length).toBe(2); // one at spawn, one re-emitted at resume (D2)
    // and only ONE distinct child thread was ever started
    const allChildStarts = store.read(sessionId).filter((e) => e.type === "thread_started");
    expect(new Set(allChildStarts.map((e) => (e as Extract<SessionEvent, { type: "thread_started" }>).threadId)).size).toBe(1);
  });

  // D1 MANDATORY: the two-resume alternation. The naive resume (input = [...childHistoryInput,
  // newPrompt] without persisting each prompt) passes the single-resume test above but CORRUPTS
  // the second resume — childHistoryInput would then rebuild [assistant1, assistant2] with NO user
  // turn between them. This exact-equality check on the SECOND resume's input is what catches it.
  test("(D1) two-resume alternation: the 2nd resume's input alternates user/assistant with no two consecutive same-role turns", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1
      text("child-out-1"),
      text("parent turn1"),
      [resumeCall("r1", "worker", "P1"), done("tool_calls")],          // turn 2: resume #1
      text("child-out-2"),
      text("parent turn2"),
      [resumeCall("r2", "worker", "P2"), done("tool_calls")],          // turn 3: resume #2
      text("child-out-3"),
      text("parent turn3"),
    ]);
    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(9); // 3 turns × 3 calls — guards the clamp

    const secondResume = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "P2");
    expect(secondResume).toBeDefined();
    // the load-bearing assertion (exact array, not `.some`/`.toContain`): every assistant turn is
    // preceded by a user turn, no two consecutive user or assistant turns
    expect(secondResume!.input).toEqual([
      M("user", "do the task"),      // opening
      M("assistant", "child-out-1"), // assistant #1
      M("user", "P1"),               // resume #1 prompt
      M("assistant", "child-out-2"), // assistant #2
      M("user", "P2"),               // resume #2 prompt
    ]);

    // no double-persist: runThread must NOT itself re-persist its input user_messages — each resume
    // prompt appears exactly ONCE as a child-scoped user_message event
    const worker = bgAgents.get("worker", sessionId)!;
    const childUserMsgs = store.read(sessionId).filter(
      (e) => e.type === "user_message" && e.threadId === worker.threadId,
    );
    expect(childUserMsgs.map((e) => (e as Extract<SessionEvent, { type: "user_message" }>).text)).toEqual(["P1", "P2"]);
  });

  // Step 1(b): resume a STILL-RUNNING agent → typed isError (resume is for FINISHED agents;
  // steer a running one via send_message, a separate task).
  test("(b) resume a still-running agent → typed isError, no new thread_started", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [resumeCall("r1", "busy", "keep going"), done("tool_calls")],
      text("parent saw the error"),
    ]);
    // a running entry the resume will collide with (real sessionId so get() resolves it)
    bgAgents.register({ agentId: "th_busy", sessionId, threadId: "th_busy", name: "busy", abort: new AbortController() });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toBe("agent 'busy' is still running — use send_message to message it");

    // no ghost thread: the running agent's own threadId never got a re-emitted thread_started
    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    // the child never ran — only the parent's two rounds hit the provider
    expect((provider as FakeProvider).requests.length).toBe(2);
  });

  // Step 1(c): resume an unknown id/name → typed isError.
  test("(c) resume an unknown agent → typed isError, no thread_started", async () => {
    const { engine, store, sessionId, provider } = setup([
      [resumeCall("r1", "ghost", "do it"), done("tool_calls")],
      text("parent saw the error"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toBe("no agent 'ghost' to resume");
    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect((provider as FakeProvider).requests.length).toBe(2);
  });

  // D7: resume set but no prompt → typed isError (a resume still needs a NEW instruction).
  test("(D7) resume with an empty prompt → typed isError requiring a prompt", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [{ type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "" }) }, done("tool_calls")],
      text("parent saw the error"),
    ]);
    bgAgents.register({ agentId: "th_w", sessionId, threadId: "th_w", name: "worker", abort: new AbortController() });
    bgAgents.complete("th_w", { ok: true, result: "done" }); // terminal, so "still running" isn't the reason

    await engine.runTurn(sessionId);
    const result = store.read(sessionId).find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toBe("resume requires a prompt (the new instruction to continue with)");
  });

  // Step 1(d): a plan-narrowed child (spawned mode:"plan" from an auto session) resumed under the
  // SAME auto session STAYS plan — D4 restrict-only: the resumed run's policy is the min of the
  // current session policy and the child's originally-captured policy, never wider.
  test("(d) a plan-narrowed child, resumed under an auto session, stays plan (its write is still blocked)", async () => {
    // Content-dispatched provider (not the index-scripted FakeProvider): the resumed child does
    // TWO rounds (a write that's plan-denied, then a wrap-up), so round-counting is brittle —
    // dispatch off input content instead (the ConcurrentModeProvider pattern).
    class PlanResumeProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound0 = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "planner-task")) {
          const lastUser = lastUserOf(input);
          if (lastUser === "planner-task") {
            // the FIRST run (turn 1): just finish so the child becomes terminal + resumable
            yield { type: "text_delta", delta: "first run done" };
            yield done("end_turn");
            return;
          }
          // the RESUMED run (lastUser === "continue"): round 0 attempts a write; after the denial
          // tool_result comes back, round 1 wraps up
          const hasResult = input.some((it) => (it as { type?: string }).type === "tool_result");
          if (!hasResult) {
            yield { type: "tool_call", callId: "w-resume", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) };
            yield done("tool_calls");
          } else {
            yield { type: "text_delta", delta: "child acknowledged the block" };
            yield done("end_turn");
          }
          return;
        }
        // MAIN thread
        const last = input[input.length - 1] as { type?: string } | undefined;
        if (last?.type === "tool_result") { // a continuation round after a spawn/resume tool_result
          yield { type: "text_delta", delta: "parent wrap" };
          yield done("end_turn");
          return;
        }
        const n = this.mainRound0++;
        if (n === 0) yield spawnNamed("s1", "planner-task", "planner", { mode: "plan" });
        else yield resumeCall("r1", "planner", "continue");
        yield done("tool_calls");
      }
    }
    const provider = new PlanResumeProvider();
    const { engine, store, sessionId } = setup([], { provider, approvalPolicy: "auto" });
    await engine.runTurn(sessionId); // turn 1: spawn planner (narrowed to plan), it finishes
    await engine.runTurn(sessionId); // turn 2: resume planner

    const events = store.read(sessionId);
    // the resumed child's write was plan-denied — proof the resume kept the child's narrowed "plan"
    // policy even though the session itself is "auto"
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w-resume");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");

    // the session's own policy is untouched by the resume
    expect(store.meta(sessionId).approvalPolicy).toBe("auto");
  });

  // D6: a resume can itself be run_in_background — the resumed run detaches and the tool_result is
  // {agentId, status:"running"} immediately, exactly like a fresh bg spawn.
  test("(D6) a run_in_background resume returns {agentId,status:running} immediately and re-completes the entry", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn
      text("child-out-1"),
      text("parent turn1"),
      [{ type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "keep going", run_in_background: true }) }, done("tool_calls")],
      text("child-out-2"), // the resumed (detached) child's run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);

    // the tool_result is set SYNCHRONOUSLY in-turn (the bg resume returns immediately), so it's
    // already present right after runTurn — assert it before waiting on the detached run
    const result = store.read(sessionId).find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: false });
    const worker = bgAgents.get("worker", sessionId)!;
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    // POLL for the detached resumed run to settle (no fixed sleep — a fixed timeout on a detached
    // completion is the canonical intermittent-failure pattern; poll in 5ms steps up to a ceiling)
    for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // the detached resumed run re-completed the entry, and (unlike a sync resume) left it UN-notified
    // so the next turn's completion reminder can surface it (CC parity)
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed", notified: false });
  });
});
