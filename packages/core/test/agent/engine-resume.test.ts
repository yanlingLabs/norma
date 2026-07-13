import { describe, expect, spyOn, test } from "bun:test";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import type { SessionEvent } from "@norma/protocol";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { setup } from "./engine-spawn.test";

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// A fresh spawn with a stable `name` so a later turn can address it by name for resume (the model
// can't know the generated agentId in advance; `name` is the stable handle — 4h-ii-b Task 2).
// 5a: `run_in_background: false` defaulted (before `...extra`, so an explicit override still
// wins) — depth 0 now backgrounds by default (this file's `setup()`, imported from
// engine-spawn.test.ts, always wires `bgAgents`), and every test below needs this FIRST spawn to
// complete synchronously so the resulting agent is actually FINISHED and resumable in the turn
// that follows; none of them are testing the default itself.
const spawnNamed = (callId: string, prompt: string, name: string, extra?: Record<string, unknown>): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "task", name, run_in_background: false, ...extra }) });
// A resume: `resume` + a NEW `prompt`, and DELIBERATELY no `description` — resume sits before the
// bridge's description check (D7), so it must succeed without one.
// 5a: `run_in_background: false` — a resume is itself a spawn and follows the SAME depth-0 default
// flip (the brief: "a resume is a spawn and follows the same default"), so every test below that
// resumes and then inspects the resumed run's OWN provider request/history SYNCHRONOUSLY (no poll
// loop) needs this pinned false; the dedicated default-matrix test below omits the key by hand to
// pin the true default instead.
const resumeCall = (callId: string, resume: string, prompt: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ resume, prompt, run_in_background: false }) });

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

  // history-parity Task 3 (test d): a child whose stored history includes a reasoning_item — emitted
  // during its first run, BEFORE its closing assistant message — resumes cleanly. The
  // clean-termination guard (which only inspects the LAST reconstructed item) still sees an
  // assistant message as last (reasoning precedes it, per Codex emission order), so the resume is
  // NOT rejected; and childHistoryInput replays the reasoning item VERBATIM into the resumed run's
  // input, in emission order, ahead of the child's own assistant reply.
  test("(d) a resumed child replays its reasoning_item; the clean-termination guard still sees last-item = assistant", async () => {
    const recJson = (ec: string) => JSON.stringify({ type: "reasoning", summary: [], encrypted_content: ec });
    const RI = (ec: string): ProviderEvent => ({ type: "reasoning_item", itemJson: recJson(ec) });
    const REAS = (ec: string) => ({ type: "reasoning" as const, itemJson: recJson(ec) });
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")],               // turn 1: spawn
      [RI("EC1"), { type: "text_delta", delta: "child-out-1" }, done("end_turn")],   // child run 1: reasoning THEN reply
      text("parent turn1"),                                                          // main continuation
      [resumeCall("r1", "worker", "now do Y"), done("tool_calls")],                  // turn 2: resume
      text("child-out-2"),                                                           // resumed child run
      text("parent turn2"),                                                          // main continuation
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn "worker" (child emits a reasoning item, then finishes)
    await engine.runTurn(sessionId); // turn 2: resume "worker" — must PASS the clean-termination guard

    const fp = provider as FakeProvider;
    // the RESUMED child's own provider request, found by content (opening + new prompt) — never by
    // index. Its EXISTENCE proves the guard passed (a rejected resume never re-runs the child).
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "now do Y");
    expect(resumed).toBeDefined();
    // the reasoning item replays verbatim, in emission order, ahead of the child's own reply.
    expect(resumed!.input).toEqual([
      M("user", "do the task"),      // opening prompt, prepended
      REAS("EC1"),                   // the child's reasoning item, replayed from the store
      M("assistant", "child-out-1"), // the child's OWN prior reply
      M("user", "now do Y"),         // the new instruction
    ]);

    // in the child's stored history the reasoning item precedes the assistant message that closed
    // run 1 — exactly the emission-order shape the clean-termination guard reconstructs at resume
    // time ([reasoning, assistant], last = assistant), which is why the resume above was accepted.
    const worker = bgAgents.get("worker", sessionId)!;
    const childEvents = store.read(sessionId).filter((e) => "threadId" in e && e.threadId === worker.threadId);
    const firstReasoningSeq = childEvents.find((e) => e.type === "reasoning_item")!.seq;
    const firstAssistantSeq = childEvents.find((e) => e.type === "assistant_message")!.seq;
    expect(firstReasoningSeq).toBeLessThan(firstAssistantSeq);
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
    // bg-retrigger T1 (concern fix): the detached RESUME's settle handler now persists the
    // completion notice itself (notifyBgCompletion), exactly like a fresh detached spawn —
    // reopen() reset `notified` at resume time, so the claim fires again for the resumed run's
    // OWN completion (CC parity: a resumed agent that finishes again notifies again). The
    // original SYNC spawn completed {notified:true}, so this is the session's ONLY notification.
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed", notified: true });
    const notes = store.read(sessionId).filter((e) => e.type === "task_notification");
    expect(notes).toHaveLength(1);
    expect((notes[0] as Extract<SessionEvent, { type: "task_notification" }>).content)
      .toContain("<result>child-out-2</result>");
  });

  // 5a matrix case 7 (USER pin: background children, CC parity — phase 5a T2): a resume is itself
  // a spawn (the SAME hand-parsed `runInBackground` the bridge computes for a fresh spawn feeds
  // resumeThread too — see engine.ts's spawn bridge), so it follows the identical depth-0 default:
  // omitting run_in_background on a `resume` at depth 0 with the registry wired now means
  // DETACHED, exactly like (D6) above (which pins the SAME behavior via an EXPLICIT `true`).
  // Constructs its own tool_call, omitting the key entirely, to prove the engine's own default
  // rather than resumeCall's test-helper default (`false`, added above for every OTHER test here).
  test("(5a matrix #7) resume + run_in_background OMITTED at depth 0 → detached reopen, same as an explicit true", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn (helper default)
      text("child-out-1"),
      text("parent turn1"),
      [{ type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "keep going" }) }, done("tool_calls")],
      text("child-out-2"), // the resumed (detached) child's run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);

    // the tool_result is set SYNCHRONOUSLY in-turn (the bg resume returns immediately) — asserted
    // before waiting on the detached run, exactly like (D6)
    const result = store.read(sessionId).find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: false });
    const worker = bgAgents.get("worker", sessionId)!;
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed", result: "child-out-2" });
  });

  // 4h-ii-c (T1 follow-up): a RESUMED bg run is just as detached as a fresh bg spawn — a
  // send_message to a finished agent ALWAYS resumes with runInBackground:true, so this path is
  // mainstream, not an edge. Same policy as the fresh bg spawn branch: `timeoutMs: null`
  // (untimed; entryAbort/task_stop is the only kill), and `result.timedOut` threads into the
  // completion so a timed-out resumed agent reports "timeout", never generic "failed".
  test("(4h-ii-c) a run_in_background resume's subagents.run receives timeoutMs:null (untimed, same as a fresh bg spawn)", async () => {
    const { engine, sessionId, bgAgents, subagents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn
      text("child-out-1"),
      text("parent turn1"),
      [{ type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "keep going", run_in_background: true }) }, done("tool_calls")],
      text("child-out-2"), // the resumed (detached) child's run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn "worker" sync (spy NOT yet installed — its run() call is out of frame)
    const spy = spyOn(subagents!, "run");
    try {
      await engine.runTurn(sessionId); // turn 2: bg resume — the only run() call the spy sees
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: null });
      // let the detached resumed run settle before the test ends (no dangling chain)
      for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(bgAgents.get("worker", sessionId)?.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });

  test("(4h-ii-c) a bg resume whose run() result carries timedOut:true completes the entry with status 'timeout', not 'failed'", async () => {
    const { engine, sessionId, bgAgents, subagents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn
      text("child-out-1"),
      text("parent turn1"),
      [{ type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "keep going", run_in_background: true }) }, done("tool_calls")],
      text("parent turn2"), // the resumed child's own run never reaches the provider (run() is mocked below)
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn "worker" sync
    // Mock the RESUME's run() to resolve as a typed timeout — only reachable in production if a
    // future config re-adds a bg timeout (the call itself now passes timeoutMs:null), but the
    // completion mapping must already report it as "timeout", never generic "failed".
    const spy = spyOn(subagents!, "run").mockImplementation(
      async () => ({ ok: false as const, error: "timed out after 300s", timedOut: true as const }),
    );
    try {
      await engine.runTurn(sessionId); // turn 2: bg resume — detached chain gets the mocked timeout result
      for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const worker = bgAgents.get("worker", sessionId);
      expect(worker?.status).toBe("timeout");
      expect(worker?.result).toContain("timed out after 300s");
    } finally {
      spy.mockRestore();
    }
  });

  // FINDING 1 (T3 review, IMPORTANT): resuming a child whose stored history does NOT end on an
  // assistant turn (a capped/failed/mid-tool child — its last event is a tool_result or an orphan
  // function_call) must be REJECTED with a typed error BEFORE any side effect, never handed to the
  // provider as [...tool_result, user(newPrompt)] (a non-standard adjacency; the orphan-function_call
  // variant is a near-certain hard provider reject — openai-compatible mapInput is a blind 1:1 map).
  // This is a HISTORY-SHAPE check, not a status check: status is orthogonal to last-event shape (a
  // human-denied child is `completed` yet ends on a tool_result; a capped child is `failed`; a
  // cleanly-stopped child is `stopped` yet ends on an assistant turn and SHOULD resume). Seed the
  // child's stored history to END ON A TOOL_RESULT. Doubles as the tool-interleaving coverage the
  // review flagged as missing.
  test("(F1) resume a child whose history ends on a tool_result → typed isError, no ghost thread, no persist", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: spawn (completes clean)
      text("child-out-1"),                                             // child run 1 (ends on assistant)
      text("parent turn1"),
      [resumeCall("r1", "worker", "continue"), done("tool_calls")],    // turn 2: resume attempt → guard fires
      text("parent turn2"),                                           // main continuation after the isError
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn worker, it completes cleanly
    const worker = bgAgents.get("worker", sessionId)!;

    // Make the child's stored history END ON A TOOL_RESULT — a trailing tool_call + tool_result with
    // no closing assistant_message (the shape a capped / mid-tool child leaves behind).
    store.append(sessionId, { type: "tool_call", sessionId, threadId: worker.threadId, callId: "orphan", name: "read", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: worker.threadId, callId: "orphan", output: "partial", isError: false });

    await engine.runTurn(sessionId); // turn 2: resume "worker" with "continue" → clean-termination guard fires

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("didn't finish cleanly");

    // no ghost thread: the guard fired BEFORE the thread_started re-emit → still exactly ONE
    // thread_started for the child (the spawn), not a second one for the aborted resume.
    const childStarts = events.filter((e) => e.type === "thread_started" && e.threadId === worker.threadId);
    expect(childStarts.length).toBe(1);

    // guard fired BEFORE the user_message persist → the new prompt was NOT appended to the child's history
    const childUserMsgs = events.filter((e) => e.type === "user_message" && e.threadId === worker.threadId);
    expect(childUserMsgs.some((e) => (e as Extract<SessionEvent, { type: "user_message" }>).text === "continue")).toBe(false);

    // the child never re-ran — only turn 1's 3 calls + turn 2's 2 parent rounds hit the provider
    expect((provider as FakeProvider).requests.length).toBe(5);
  });

  // FINDING 2 (T3 review, MINOR): an isolation:"worktree" child's worktree is torn down on clean
  // completion, so on resume rc.roots points at a removed dir → fs/bash tools would fence to a gone
  // directory and error confusingly. Reject with a typed error up front. Seed a CLEAN child (ends on
  // an assistant turn, so the clean-termination guard passes and we actually reach this guard), then
  // point its captured resume.roots at a bogus path to simulate the removed worktree.
  test("(F2) resume an isolated child whose worktree was removed → typed isError", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: spawn (completes clean)
      text("child-out-1"),                                             // child run 1 (ends on assistant)
      text("parent turn1"),
      [resumeCall("r1", "worker", "continue"), done("tool_calls")],    // turn 2: resume attempt → guard fires
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn worker cleanly
    const worker = bgAgents.get("worker", sessionId)!;
    // simulate an isolated child whose worktree was torn down: point the captured roots at a path
    // that does not exist (mutates the live registry entry by reference, so rc.roots sees it).
    worker.resume!.roots = ["/norma-nonexistent-worktree-4h-ii-b/gone"];

    await engine.runTurn(sessionId); // turn 2: resume → worktree guard fires

    const result = store.read(sessionId).find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("worktree was removed");
  });

  // whole-branch #3 (MINOR): the clean-termination guard inspects the LAST reconstructed child item
  // and requires it to be an assistant message. But a cleanly-finished child whose FINAL round
  // emitted a reasoning item then ended the turn with EMPTY assistant text (engine.ts's
  // `if (textBuf.length > 0)` persists no assistant_message) leaves a TRAILING reasoning_item as its
  // last item — which the naive guard rejected as "didn't finish cleanly". Reasoning is opaque,
  // order-transparent state (it always PRECEDES the item it reasons for), so the guard must SKIP
  // trailing reasoning items and check the last REAL item.
  test("(#3a) resume a child whose history ends [assistant, reasoning] → ALLOWED, reasoning replays", async () => {
    const recJson = (ec: string) => JSON.stringify({ type: "reasoning", summary: [], encrypted_content: ec });
    const REAS = (ec: string) => ({ type: "reasoning" as const, itemJson: recJson(ec) });
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: spawn (completes clean, ends on assistant)
      text("child-out-1"),                                             // child run 1
      text("parent turn1"),
      [resumeCall("r1", "worker", "continue"), done("tool_calls")],    // turn 2: resume → guard must PASS
      text("child-out-2"),                                             // resumed child run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn worker, completes cleanly
    const worker = bgAgents.get("worker", sessionId)!;

    // make the child's stored history END ON A TRAILING REASONING ITEM (after its closing assistant) —
    // the shape a child leaves when its final round emitted reasoning then ended with empty text.
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: worker.threadId, itemJson: recJson("EC1") });

    await engine.runTurn(sessionId); // turn 2: resume "worker" — the guard must skip the trailing reasoning

    const fp = provider as FakeProvider;
    // the resumed child's own provider request EXISTS → proof the guard passed (a rejected resume never re-runs the child)
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "continue");
    expect(resumed).toBeDefined();
    // the trailing reasoning item replays verbatim into the resumed input, in seq order
    expect(resumed!.input).toEqual([
      M("user", "do the task"),      // opening prompt, prepended
      M("assistant", "child-out-1"), // the child's OWN prior reply
      REAS("EC1"),                   // the trailing reasoning item, replayed from the store
      M("user", "continue"),         // the new instruction
    ]);
  });

  // whole-branch #3: skipping trailing reasoning must NOT rescue a genuinely-unclean child. A child
  // ending [tool_result, reasoning] (mid-tool, no closing assistant, then a stray reasoning item) has
  // a TOOL_RESULT as its last REAL item → STILL rejected.
  test("(#3b) resume a child whose history ends [tool_result, reasoning] → STILL rejected", async () => {
    const recJson = (ec: string) => JSON.stringify({ type: "reasoning", summary: [], encrypted_content: ec });
    const { engine, store, sessionId, provider, bgAgents } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: spawn (completes clean)
      text("child-out-1"),
      text("parent turn1"),
      [resumeCall("r1", "worker", "continue"), done("tool_calls")],    // turn 2: resume attempt → guard fires
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId);
    const worker = bgAgents.get("worker", sessionId)!;

    // child history ends on a tool_result FOLLOWED BY a trailing reasoning item: the last REAL item is
    // a tool_result → NOT resumable, even though the very last item is reasoning.
    store.append(sessionId, { type: "tool_call", sessionId, threadId: worker.threadId, callId: "orphan", name: "read", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: worker.threadId, callId: "orphan", output: "partial", isError: false });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: worker.threadId, itemJson: recJson("EC1") });

    await engine.runTurn(sessionId); // turn 2: resume → clean-termination guard STILL fires

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("didn't finish cleanly");
    // no child re-run: only turn 1's 3 calls + turn 2's 2 parent rounds hit the provider
    expect((provider as FakeProvider).requests.length).toBe(5);
  });
});
