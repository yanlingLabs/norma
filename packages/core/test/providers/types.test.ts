import { describe, expect, test } from "bun:test";
import { ProviderEvent } from "../../src/providers/types";

describe("ProviderEvent schema", () => {
  test("all variants parse", () => {
    const events = [
      { type: "text_delta", delta: "hel" },
      { type: "tool_call", callId: "c1", name: "bash", argsJson: '{"command":"ls"}' },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "done", stopReason: "end_turn" },
      { type: "error", code: "rate_limit", message: "429", retryAfterMs: 2000 },
    ] as const;
    for (const e of events) expect(ProviderEvent.parse(e).type).toBe(e.type);
  });

  test("unknown stop reason / error code rejected", () => {
    expect(() => ProviderEvent.parse({ type: "done", stopReason: "vibes" })).toThrow();
    expect(() => ProviderEvent.parse({ type: "error", code: "cosmic", message: "x" })).toThrow();
  });
});
