import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../../src/providers/types";
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

// history-parity Task 3 helpers: an opaque provider reasoning item (encrypted_content) as the
// provider yields it, and the TurnInputItem it replays into on later requests.
const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const recJson = (ec: string) => JSON.stringify({ type: "reasoning", summary: [], encrypted_content: ec });
const RI = (ec: string): ProviderEvent => ({ type: "reasoning_item", itemJson: recJson(ec) });
const REAS = (ec: string) => ({ type: "reasoning" as const, itemJson: recJson(ec) });

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

// history-parity Task 3: the engine captures provider reasoning items, PERSISTS them at arrival
// (so their store seq = provider emission order), PREFIXES the round's reasoning ahead of that
// round's message/function_calls in-turn, and replays them cross-turn via the shared eventToInput
// mapper. itemJson is SENSITIVE opaque state — the persist is its only sink.
describe("engine reasoning-item capture/persist/replay in emission order (history-parity Task 3)", () => {
  test("(b) reasoning items persist at arrival in emission order, prefix within-round, and replay cross-turn", async () => {
    const writeArgs = JSON.stringify({ path: "out.txt", content: "hi" });
    const provider = new FakeProvider([
      // turn 1, round 0: reasoning THEN a tool call
      [RI("EC1"), { type: "tool_call", callId: "c1", name: "write", argsJson: writeArgs }, done("tool_calls")],
      // turn 1, round 1: reasoning THEN the final assistant text
      [RI("EC2"), { type: "text_delta", delta: "done" }, done("end_turn")],
      // turn 2, round 0: end immediately — captures the cross-turn historyInput replay
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    await engine.runTurn(sessionId); // turn 1 (round 0: reasoning + tool call; round 1: reasoning + final text)
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });
    await engine.runTurn(sessionId); // turn 2 (captures the cross-turn replay in provider.requests[2])

    // write's exact tool_result text isn't load-bearing here — pull it verbatim from the store.
    const events = store.read(sessionId);
    const trEvent = events.find((e) => e.type === "tool_result" && e.callId === "c1") as Extract<SessionEvent, { type: "tool_result" }>;
    const TRc1 = TR("c1", trEvent.output, trEvent.isError);

    // (i) round 2's REQUEST input: round 0's reasoning precedes its function_call; nothing reordered.
    // (round 1's OWN reasoning EC2 is collected DURING this stream and appended only afterwards, so
    // it is not part of the request that opened round 2.)
    expect(provider.requests[1]!.input).toEqual([
      M("user", "u1"),
      REAS("EC1"),
      FC("c1", "write", writeArgs),
      TRc1,
    ]);

    // (ii) the store holds exactly two reasoning_item events, in emission order, with seqs BETWEEN
    // the surrounding events (EC1 after u1 and before its tool_call; EC2 after the tool_result and
    // before the closing assistant_message).
    const reasoning = events.filter((e) => e.type === "reasoning_item") as Extract<SessionEvent, { type: "reasoning_item" }>[];
    expect(reasoning.map((e) => e.itemJson)).toEqual([recJson("EC1"), recJson("EC2")]);
    const seqOf = (pred: (e: SessionEvent) => boolean) => events.find(pred)!.seq;
    const u1seq = seqOf((e) => e.type === "user_message" && e.text === "u1");
    const tcSeq = seqOf((e) => e.type === "tool_call" && e.callId === "c1");
    const trSeq = seqOf((e) => e.type === "tool_result" && e.callId === "c1");
    const asstSeq = seqOf((e) => e.type === "assistant_message" && e.text === "done");
    expect(u1seq).toBeLessThan(reasoning[0]!.seq);
    expect(reasoning[0]!.seq).toBeLessThan(tcSeq);
    expect(trSeq).toBeLessThan(reasoning[1]!.seq);
    expect(reasoning[1]!.seq).toBeLessThan(asstSeq);

    // (iii) turn 2's input replays the whole prior turn cross-turn via historyInput — both reasoning
    // items in emission order, verbatim.
    expect(provider.requests[2]!.input).toEqual([
      M("user", "u1"),
      REAS("EC1"),
      FC("c1", "write", writeArgs),
      TRc1,
      REAS("EC2"),
      M("assistant", "done"),
      M("user", "u2"),
    ]);
  });

  test("(c) a checkpoint covering the reasoning-bearing turn folds the reasoning items away — none survive in the built input", async () => {
    const provider = okProvider();
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: recJson("EC1") });
    store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "c1", name: "read", argsJson: '{"path":"a.txt"}' });
    store.append(sessionId, { type: "tool_result", sessionId, threadId: "main", callId: "c1", output: "file contents", isError: false });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: recJson("EC2") });
    const a1 = store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
    // checkpoint folds the WHOLE reasoning-bearing turn (uptoSeq = a1's seq, always a MESSAGE seq).
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "SUMMARY_TOKEN", uptoSeq: a1.seq });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.input).toEqual([
      { type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" },
      M("user", "u2"),
    ]);
    // no opaque reasoning state (or any reasoning item) leaked past the fold.
    const serialized = JSON.stringify(provider.requests[0]!.input);
    expect(serialized).not.toContain("EC1");
    expect(serialized).not.toContain("EC2");
    expect(serialized).not.toContain("reasoning");
  });
});
