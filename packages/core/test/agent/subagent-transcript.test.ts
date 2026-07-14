import { describe, expect, spyOn, test } from "bun:test";
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

  // ---- task-9 review, Important: allowlist polarity — an unknown/future event type is EXCLUDED
  // by default (fail closed), so a new sensitive SessionEvent variant can never silently land in
  // a model-greppable file. (At compile time the `satisfies Record<SessionEvent["type"], boolean>`
  // clause additionally forces an explicit include/exclude decision for every new variant.)
  test("an UNKNOWN/future event type is excluded by default — never written, never bootstraps the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 1, "general-purpose", "do the task"));
    const futureEvent = {
      type: "future_sensitive_event", seq: 2, sessionId: "s1", threadId: "th_a", ts: 2,
      secret: "FUTURE-SENSITIVE-PAYLOAD",
    } as unknown as SessionEvent; // simulates a protocol variant added after this allowlist
    w.append("s1", "th_a", futureEvent);
    const raw = readFileSync(w.pathFor("s1", "th_a")!, "utf8");
    expect(raw).not.toContain("future_sensitive_event");
    expect(raw).not.toContain("FUTURE-SENSITIVE-PAYLOAD");
    // and as the very FIRST event for a fresh thread, it doesn't even bootstrap the file
    const w2 = new SubagentTranscripts(() => dir);
    w2.append("s1", "th_fresh", futureEvent);
    expect(existsSync(w2.pathFor("s1", "th_fresh")!)).toBe(false);
  });

  test("a real-but-excluded persisted type (task_notification) is not written either", () => {
    const dir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-"));
    const w = new SubagentTranscripts(() => dir);
    w.append("s1", "th_a", threadStarted("s1", "th_a", 1, "general-purpose", "do the task"));
    w.append("s1", "th_a", { type: "task_notification", seq: 2, sessionId: "s1", threadId: "th_a", content: "<task-notification>x</task-notification>", ts: 2 });
    expect(readFileSync(w.pathFor("s1", "th_a")!, "utf8")).not.toContain("task_notification");
  });

  // ---- task-9 review, Minors 1+3: failure isolation is PER-(sessionId, threadId) — warn once
  // for the failing key, disable further attempts for it (no per-event mkdir retry storm), and
  // leave every OTHER thread/session's writer fully functional.
  test("an fs error disables THAT thread only: one warning, no retries, no throw — and a healthy session still writes", () => {
    const badDir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-bad-"));
    const goodDir = mkdtempSync(join(tmpdir(), "norma-subagent-transcript-good-"));
    // Pre-create `subagents` as a FILE (not a dir) so mkdirSync(..., {recursive:true}) throws ENOTDIR
    // for sBad, while sGood's dir stays healthy.
    writeFileSync(join(badDir, "subagents"), "not a directory");
    const w = new SubagentTranscripts((sid) => (sid === "sBad" ? badDir : goodDir));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => w.append("sBad", "th_a", threadStarted("sBad", "th_a", 1, "general-purpose", "x"))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1); // warned once for this key
      expect(() => w.append("sBad", "th_a", toolCall("sBad", "th_a", 2))).not.toThrow();
      expect(() => w.append("sBad", "th_a", toolCall("sBad", "th_a", 3))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1); // still once — disabled, no per-event retry/warn storm

      // a DIFFERENT session through the SAME writer instance is completely unaffected
      w.append("sGood", "th_b", threadStarted("sGood", "th_b", 4, "general-purpose", "healthy"));
      expect(linesOf(w.pathFor("sGood", "th_b")!)[0]).toMatchObject({ prompt: "healthy" });
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a THROWING tmpDirOf never escapes: append warns once + disables that thread; pathFor resolves undefined", () => {
    let calls = 0;
    const w = new SubagentTranscripts((sid) => {
      if (sid === "sBoom") { calls++; throw new Error("tmp dir exploded"); }
      return undefined;
    });
    expect(w.pathFor("sBoom", "th_a")).toBeUndefined(); // surface accessor swallows, omits the path

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => w.append("sBoom", "th_a", threadStarted("sBoom", "th_a", 1, "general-purpose", "x"))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      const callsAfterFirst = calls;
      expect(() => w.append("sBoom", "th_a", toolCall("sBoom", "th_a", 2))).not.toThrow();
      expect(calls).toBe(callsAfterFirst); // disabled key → tmpDirOf isn't even consulted again
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
