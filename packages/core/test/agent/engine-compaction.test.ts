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
});
