import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SubagentTranscripts } from "../../src/agent/subagent-transcript";

// CC-parity subagent transcript files: one JSONL file per child thread, keyed (sessionId,
// threadId), lazily created under <tmpDir>/subagents/agent-<threadId>.jsonl. These are pure
// writer-module tests (no engine) — the emit-hook wiring is covered separately in
// subagent-transcript-e2e.test.ts.

const threadStarted = (sessionId: string, threadId: string, ts: number, agentType: string, prompt: string): SessionEvent => ({
  type: "thread_started", seq: 1, sessionId, threadId, parentThreadId: "main", agentType, prompt, ts,
});
const toolCall = (sessionId: string, threadId: string, seq: number): SessionEvent => ({
  type: "tool_call", seq, sessionId, threadId, callId: "c1", name: "read", argsJson: "{}", ts: seq,
});
const reasoningItem = (sessionId: string, threadId: string, seq: number): SessionEvent => ({
  type: "reasoning_item", seq, sessionId, threadId, itemJson: "TOP-SECRET-encrypted-content", ts: seq,
});

function linesOf(path: string): unknown[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("SubagentTranscripts", () => {
  test("pathFor is a pure computation, undefined when tmpDirOf resolves to undefined", () => {
    const w = new SubagentTranscripts(() => undefined);
    expect(w.pathFor("s1", "th_a")).toBeUndefined();
  });

  test("pathFor returns <tmpDir>/subagents/agent-<threadId>.jsonl when tmpDirOf resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    expect(w.pathFor("s1", "th_a")).toBe(join(dir, "subagents", "agent-th_a.jsonl"));
  });

  test("append lazily creates the subagents/ directory and the file on first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    const path = w.pathFor("s1", "th_a")!;
    expect(existsSync(path)).toBe(false);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 100, "general-purpose", "do the task"));
    expect(existsSync(path)).toBe(true);
  });

  test("the first line is a synthetic spawn_prompt line derived from thread_started, followed by the event itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 100, "code-reviewer", "review this PR"));
    const lines = linesOf(w.pathFor("s1", "th_a")!);
    expect(lines[0]).toEqual({ type: "spawn_prompt", ts: 100, agentType: "code-reviewer", prompt: "review this PR" });
    expect(lines[1]).toMatchObject({ type: "thread_started", agentType: "code-reviewer", prompt: "review this PR" });
    expect(lines).toHaveLength(2);
  });

  test("subsequent events append as plain lines, no repeated spawn_prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 100, "general-purpose", "do the task"));
    w.append("s1", "th_a", toolCall("s1", "th_a", 2));
    w.append("s1", "th_a", toolCall("s1", "th_a", 3));
    const lines = linesOf(w.pathFor("s1", "th_a")!);
    expect(lines).toHaveLength(4); // spawn_prompt + thread_started + 2 tool_calls
    expect(lines.filter((l) => (l as { type: string }).type === "spawn_prompt")).toHaveLength(1);
  });

  test("reasoning_item events are excluded entirely — never written, not even as raw bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 100, "general-purpose", "do the task"));
    w.append("s1", "th_a", reasoningItem("s1", "th_a", 2));
    w.append("s1", "th_a", toolCall("s1", "th_a", 3));
    const raw = readFileSync(w.pathFor("s1", "th_a")!, "utf8");
    expect(raw).not.toContain("TOP-SECRET-encrypted-content");
    expect(raw).not.toContain("reasoning_item");
    const lines = linesOf(w.pathFor("s1", "th_a")!);
    expect(lines).toHaveLength(3); // spawn_prompt + thread_started + the trailing tool_call (reasoning_item excluded)
  });

  test("reasoning_item as the very first event for a thread never bootstraps the file at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", reasoningItem("s1", "th_a", 1));
    expect(existsSync(w.pathFor("s1", "th_a")!)).toBe(false);
  });

  test("different threadIds get independent files", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 1, "general-purpose", "task A"));
    w.append("s1", "th_b", threadStarted("s1", "th_b", 2, "general-purpose", "task B"));
    expect(linesOf(w.pathFor("s1", "th_a")!)[0]).toMatchObject({ prompt: "task A" });
    expect(linesOf(w.pathFor("s1", "th_b")!)[0]).toMatchObject({ prompt: "task B" });
  });

  test("an fs error (mkdir target is actually a file) is caught, logged once, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    // Pre-create `subagents` as a FILE (not a dir) so mkdirSync(..., {recursive:true}) throws ENOTDIR.
    writeFileSync(join(dir, "subagents"), "not a directory");
    const w = new SubagentTranscripts(() => dir);
    expect(() => w.append("s1", "th_a", threadStarted("s1", "th_a", 1, "general-purpose", "x"))).not.toThrow();
    expect(() => w.append("s1", "th_a", toolCall("s1", "th_a", 2))).not.toThrow();
  });
});
