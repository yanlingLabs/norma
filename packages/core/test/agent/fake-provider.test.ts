import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";

describe("FakeProvider", () => {
  test("plays scripted turns in order and records requests", async () => {
    const p = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "read", argsJson: '{"path":"a"}' }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "hi" }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "done", stopReason: "end_turn" }],
    ]);
    const first = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) first.push(e);
    expect(first[0]).toMatchObject({ type: "tool_call" });
    const second = [];
    for await (const e of p.streamTurn({ model: "m", input: [{ type: "message", role: "user", content: "x" }] })) second.push(e);
    expect(second.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.input).toHaveLength(1);
  });
});
