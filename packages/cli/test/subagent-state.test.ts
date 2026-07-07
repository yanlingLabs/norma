import { describe, expect, test } from "bun:test";
import { updateSubagents, type CliSubagent } from "../src/subagent-state";

const spawn = { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go do it", description: "explore auth module" };

describe("updateSubagents (spec §2, CLI column: lifecycle + tokens, NO time)", () => {
  test("thread_started inserts queued with label; duplicate threadId is a no-op", () => {
    const s1 = updateSubagents([], spawn);
    expect(s1).toEqual([{ threadId: "th_a", agentType: "general-purpose", label: "explore auth module", status: "queued", outputTokens: 0, liveOutputChars: 0 }]);
    expect(updateSubagents(s1, spawn)).toBe(s1); // same reference — replay dedupe
  });

  test("child turn_started → working; ghost threadIds are no-ops", () => {
    const s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a" });
    expect(s[0]!.status).toBe("working");
    expect(updateSubagents(s, { type: "turn_started", threadId: "th_ghost" })).toBe(s);
  });

  test("child deltas accumulate; turn_completed banks tokens and reconciles the estimate", () => {
    let s = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a" });
    s = updateSubagents(s, { type: "assistant_delta", threadId: "th_a", delta: "hello wor" }); // 9 chars
    expect(s[0]!.liveOutputChars).toBe(9);
    s = updateSubagents(s, { type: "turn_completed", threadId: "th_a", stopReason: "end_turn", inputTokens: 1200, outputTokens: 42 });
    expect(s[0]).toMatchObject({ inputTokens: 1200, outputTokens: 42, liveOutputChars: 0, status: "working" });
  });

  test("thread_completed → done; main turn_completed prunes; main deltas ignored", () => {
    let s = updateSubagents([], spawn);
    expect(updateSubagents(s, { type: "assistant_delta", threadId: "main", delta: "xx" })).toBe(s);
    s = updateSubagents(s, { type: "thread_completed", threadId: "th_a", stopReason: "end_turn" });
    expect(s[0]!.status).toBe("done");
    expect(updateSubagents(s, { type: "turn_completed", threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 })).toEqual([]);
  });

  test("main agent_error prunes defensively", () => {
    const s = updateSubagents([], spawn);
    expect(updateSubagents(s, { type: "agent_error", threadId: "main", message: "boom" })).toEqual([]);
  });
});
