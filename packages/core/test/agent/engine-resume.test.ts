import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

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
