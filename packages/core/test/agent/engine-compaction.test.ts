import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

describe("engine historyInput is checkpoint-aware", () => {
  test("a turn's input is [summary] + only messages AFTER the latest checkpoint's uptoSeq", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);

    // seed u0/a0..u4/a4 (5 pairs)
    for (let i = 0; i < 5; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    const msgs = store.read(sessionId).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    // checkpoint covers u0..a2 (the first 6 messages); u3/a3, u4/a4 remain as the tail
    const uptoSeq = msgs[5]!.seq; // seq of a2
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "SUMMARY_TOKEN", uptoSeq });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    const serialized = JSON.stringify(input);

    // summary present, once, as the first item:
    expect(serialized).toContain("[Summary of earlier conversation]");
    expect(serialized).toContain("SUMMARY_TOKEN");
    expect(input[0]).toMatchObject({ type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" });

    // tail (post-checkpoint) messages present:
    expect(serialized).toContain("u3");
    expect(serialized).toContain("a3");
    expect(serialized).toContain("u4");
    expect(serialized).toContain("a4");

    // pre-checkpoint messages NOT present:
    expect(input.some((it) => "content" in it && it.content === "u0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u1")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a2")).toBe(false);
  });

  test("no checkpoint -> full history, unchanged behavior", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });

    await engine.runTurn(sessionId);

    const serialized = JSON.stringify(provider.requests[0]!.input);
    expect(serialized).toContain("hello");
    expect(serialized).not.toContain("[Summary of earlier conversation]");
  });

  test("multiple checkpoints: input uses the LATEST checkpoint's summary and uptoSeq, not the earlier one's", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, store, sessionId } = setupEngine(provider);

    // seed u0/a0..u7/a7 (8 pairs)
    for (let i = 0; i < 8; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    const msgs = store.read(sessionId).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    // earlier checkpoint: covers u0..a2 (first 6 messages)
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "OLD_SUMMARY", uptoSeq: msgs[5]!.seq });
    // latest checkpoint: covers u0..a4 (first 10 messages) — supersedes the earlier one
    store.append(sessionId, { type: "checkpoint", sessionId, threadId: "main", summary: "NEW_SUMMARY", uptoSeq: msgs[9]!.seq });

    await engine.runTurn(sessionId);

    const input = provider.requests[0]!.input;
    const serialized = JSON.stringify(input);

    // the LATEST checkpoint's summary is used, exactly once; the earlier one's is not:
    expect(serialized).toContain("NEW_SUMMARY");
    expect(serialized).not.toContain("OLD_SUMMARY");

    // tail = messages after the LATEST checkpoint's uptoSeq (u5..a7):
    expect(serialized).toContain("u5");
    expect(serialized).toContain("a7");

    // messages folded into the latest checkpoint (including ones the earlier checkpoint left as
    // tail, e.g. u3/u4) are NOT present verbatim:
    expect(input.some((it) => "content" in it && it.content === "u0")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u3")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "u4")).toBe(false);
    expect(input.some((it) => "content" in it && it.content === "a4")).toBe(false);
  });
});

describe("engine auto-compact trigger (at turn start, off real provider-reported inputTokens)", () => {
  // FakeProvider's models() must report a ModelInfo whose id matches the model setupEngine's
  // harness hardcodes onto EngineConfig.provider ("gated-1") — otherwise contextWindow() can't
  // resolve a contextWindow for it and the threshold is effectively Infinity.
  const SMALL_MODEL = { id: "gated-1", family: "fake", contextWindow: 1000, supportsVision: false };
  // threshold = contextWindow(1000) * NORMA_COMPACT_THRESHOLD_FRAC(default 0.75) = 750

  function seedMessages(store: ReturnType<typeof setupEngine>["store"], sessionId: string, n: number) {
    for (let i = 0; i < n; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
  }

  test("inputTokens over the threshold triggers a compaction before the turn's own streamTurn call", async () => {
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, { type: "done", stopReason: "end_turn" }], // the compaction's own streamTurn
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }], // the actual turn's streamTurn
      ],
      [SMALL_MODEL],
    );
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5); // 10 messages, > Compactor's default keepTail(6) → compactable
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10 }); // 900 > 750

    await engine.runTurn(sessionId);

    // a checkpoint landed (auto-compact ran):
    const checkpoint = store.read(sessionId).find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeDefined();
    expect(checkpoint && "summary" in checkpoint && checkpoint.summary).toBe("SUMMARY_TOKEN");

    // the compaction's streamTurn happened FIRST, the turn's own streamTurn SECOND:
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.instructions).toContain("compacting");

    // the turn's own input (built by historyInput AFTER auto-compact ran) reflects the
    // checkpoint — auto-compact ran before historyInput, not after:
    const turnInput = provider.requests[1]!.input;
    const serialized = JSON.stringify(turnInput);
    expect(serialized).toContain("[Summary of earlier conversation]");
    expect(serialized).toContain("SUMMARY_TOKEN");
    expect(turnInput.some((it) => "content" in it && it.content === "u0")).toBe(false);
  });

  test("inputTokens under the threshold does not trigger compaction", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]], [SMALL_MODEL]);
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5);
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 100, outputTokens: 10 }); // 100 < 750

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests).toHaveLength(1); // only the turn's own streamTurn — no compaction call
  });

  test("first turn (no prior turn_completed) does not trigger compaction", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]], [SMALL_MODEL]);
    const { engine, store, sessionId } = setupEngine(provider);
    seedMessages(store, sessionId, 5); // plenty of messages to compact, but no turn_completed yet

    await engine.runTurn(sessionId);

    expect(store.read(sessionId).some((e) => e.type === "checkpoint")).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });
});
