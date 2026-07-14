import { describe, expect, test } from "bun:test";
import { updateSubagents, type CliSubagent } from "../src/subagent-state";

const spawn = { type: "thread_started", threadId: "th_a", parentThreadId: "main", agentType: "general-purpose", prompt: "go do it", description: "explore auth module" };

describe("updateSubagents (spec §2, CLI column: lifecycle + tokens, NO time)", () => {
  test("thread_started inserts queued with label; duplicate threadId is a no-op", () => {
    const s1 = updateSubagents([], spawn);
    expect(s1).toEqual([{ threadId: "th_a", agentType: "general-purpose", label: "explore auth module", status: "queued", outputTokens: 0, liveOutputChars: 0, activeMs: 0, toolCalls: 0 }]);
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

  test("child turn window banks active span; thread_completed defensively closes", () => {
    let s = updateSubagents([], spawn);
    s = updateSubagents(s, { type: "turn_started", threadId: "th_a", ts: 1000 });
    expect(s[0]!.activeSince).toBe(1000);
    s = updateSubagents(s, { type: "turn_completed", threadId: "th_a", ts: 4500, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
    expect(s[0]).toMatchObject({ activeMs: 3500, activeSince: undefined });
    // defensive close path
    let d = updateSubagents(updateSubagents([], spawn), { type: "turn_started", threadId: "th_a", ts: 1000 });
    d = updateSubagents(d, { type: "thread_completed", threadId: "th_a", ts: 6000, stopReason: "aborted" });
    expect(d[0]).toMatchObject({ status: "done", activeMs: 5000, activeSince: undefined });
  });

  test("child tool_call bumps toolCalls and sets activity via extractToolDetail", () => {
    let s = updateSubagents([], spawn);
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "bun test" }) });
    s = updateSubagents(s, { type: "tool_call", threadId: "th_a", callId: "c2", name: "weird", argsJson: "{}" });
    expect(s[0]!.toolCalls).toBe(2);
    expect(s[0]!.activity).toBe("bun test"); // undefined detail keeps the previous activity
    expect(updateSubagents(s, { type: "tool_call", threadId: "main", callId: "c3", name: "bash", argsJson: "{}" })).toBe(s); // main no-op
  });

  // Roster honesty (no-timeout task): `finish` carries HOW the thread ended, off the wire's own
  // thread_completed.stopReason — while `status` stays "done" for every terminal thread (the
  // single marker all the `status !== "done"` prune/footer filters and the Swift-lockstep
  // helpers key off; see the CliSubagent doc comment).
  test("thread_completed stopReason drives `finish` (end_turn→done, error→failed, aborted→stopped) while status is always 'done'", () => {
    const finished = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "end_turn" });
    expect(finished[0]).toMatchObject({ status: "done", finish: "done" });

    const failed = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "error" });
    expect(failed[0]).toMatchObject({ status: "done", finish: "failed" });

    const stopped = updateSubagents(updateSubagents([], spawn), { type: "thread_completed", threadId: "th_a", stopReason: "aborted" });
    expect(stopped[0]).toMatchObject({ status: "done", finish: "stopped" });
  });
});
