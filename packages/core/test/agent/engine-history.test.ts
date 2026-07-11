import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// history-parity Task 1: historyInput (main thread) now replays prior turns' tool_call/tool_result
// events via the shared eventToInput mapper, not just user/assistant messages (CC parity — the
// model no longer "forgets" what its tools did across turns). childHistoryInput already did this
// for child threads (see engine-resume.test.ts); this file pins the SAME behavior for the main
// thread's checkpoint-aware historyInput, plus the checkpoint-boundary + child-leak invariants.

const M = (role: "user" | "assistant", content: string) => ({ type: "message" as const, role, content });
const FC = (callId: string, name: string, argsJson: string) => ({ type: "function_call" as const, callId, name, argsJson });
const TR = (callId: string, output: string, isError: boolean) => ({ type: "tool_result" as const, callId, output, isError });

// A one-round provider script: enough to drive a single engine.runTurn() call and capture the
// request it sent — the SAME pattern engine-compaction.test.ts uses to inspect historyInput's
// output via provider.requests[0].input.
const okProvider = () => new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" as const }]]);

describe("engine historyInput replays tool_call/tool_result (CC parity, history-parity Task 1)", () => {
  test("(a) a prior turn's tool_call/tool_result pair replays, in seq order, between its surrounding assistant messages", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    // turn 1: user -> assistant -> tool_call -> tool_result -> assistant
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: "file contents", isError: false });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a2" });
    // turn 2: user only (the turn we're about to drive)
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.input).toEqual([
      M("user", "u1"),
      M("assistant", "a1"),
      FC("c1", "read", '{"path":"a.txt"}'),
      TR("c1", "file contents", false),
      M("assistant", "a2"),
      M("user", "u2"),
    ]);
  });

  test("(b1) a checkpoint covering the tool-bearing turn folds the pair fully away — no tool items, no leaked text", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: "file contents", isError: false });
    const a2 = store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a2" });
    // checkpoint's uptoSeq covers the WHOLE tool-bearing turn (up to and including a2) — this is
    // the real Compactor's own invariant (compactor.ts's isMessage filter): uptoSeq is always a
    // MESSAGE seq, so it can never land strictly between a tool_call and its tool_result — a
    // checkpoint either folds BOTH of a pair or neither, never splits one.
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "SUMMARY_TOKEN", uptoSeq: a2.seq });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.input).toEqual([
      { type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" },
      M("user", "u2"),
    ]);
  });

  test("(b2) a checkpoint placed BEFORE a tool-bearing turn leaves that turn's function_call/tool_result pair intact in the tail", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    // an earlier, foldable turn
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u0", clientName: "test" });
    const a0 = store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a0" });
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "SUMMARY_TOKEN", uptoSeq: a0.seq });
    // the tool-bearing turn survives as tail (unfolded)
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: "file contents", isError: false });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a2" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    expect(input).toEqual([
      { type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" },
      M("user", "u1"),
      M("assistant", "a1"),
      FC("c1", "read", '{"path":"a.txt"}'),
      TR("c1", "file contents", false),
      M("assistant", "a2"),
      M("user", "u2"),
    ]);

    // scan invariant: every function_call is immediately followed by its matching tool_result,
    // before any non-tool_result item — the pair is never split/reordered.
    for (let i = 0; i < input.length; i++) {
      const it = input[i] as { type: string; callId?: string };
      if (it.type === "function_call") {
        const next = input[i + 1] as { type: string; callId?: string } | undefined;
        expect(next?.type).toBe("tool_result");
        expect(next?.callId).toBe(it.callId);
      }
    }
  });

  test("(c) history with no tool events -> input identical to today's pre-change shape (exact array)", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "hi there" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how are you", clientName: "test" });

    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.input).toEqual([
      M("user", "hello"),
      M("assistant", "hi there"),
      M("user", "how are you"),
    ]);
  });

  test("(d) child-thread tool events never leak into main input (existing invariant, re-pinned)", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "spawn something", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "on it" });
    // a child thread's own tool_call/tool_result + assistant chatter — must NOT leak into main's input
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "th_child", callId: "cc1", name: "bash", argsJson: "{}" });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "th_child", callId: "cc1", output: "child tool output", isError: false });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "th_child", text: "child chatter" });
    // main's own tool pair — proves this isn't a blanket tool-item filter, only a thread filter
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "m1", name: "read", argsJson: '{"path":"x"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "m1", output: "main tool output", isError: false });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "done" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "next", clientName: "test" });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    expect(input).toEqual([
      M("user", "spawn something"),
      M("assistant", "on it"),
      FC("m1", "read", '{"path":"x"}'),
      TR("m1", "main tool output", false),
      M("assistant", "done"),
      M("user", "next"),
    ]);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("child tool output");
    expect(serialized).not.toContain("child chatter");
    expect(serialized).not.toContain("cc1");
  });
});
