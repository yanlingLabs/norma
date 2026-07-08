import { describe, expect, test } from "bun:test";
import { SessionEvent } from "../src/events";
import { HelloParams, HelloResult, PROTOCOL_VERSION } from "../src/methods";

describe("SessionEvent discriminated union", () => {
  const base = { seq: 1, sessionId: "s_abc", ts: 1781270000000 };

  test("user_message round-trips", () => {
    const e = { ...base, type: "user_message", threadId: "main", text: "hi", clientName: "cli-1" } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
  });

  test("each variant parses and narrows on type", () => {
    const events = [
      { ...base, type: "session_created", scope: "global" },
      { ...base, type: "harness_attached", clientName: "orb" },
      { ...base, type: "harness_detached", clientName: "orb" },
      { ...base, type: "user_message", threadId: "main", text: "x", clientName: "a" },
    ] as const;
    for (const e of events) {
      const parsed = SessionEvent.parse(e);
      expect(parsed.type).toBe(e.type);
    }
  });

  test("user_message rejects empty text", () => {
    expect(() =>
      SessionEvent.parse({ ...base, type: "user_message", threadId: "main", text: "", clientName: "cli-1" })
    ).toThrow();
  });

  test("unknown type rejected; missing discriminator rejected", () => {
    expect(() => SessionEvent.parse({ ...base, type: "nope" })).toThrow();
    expect(() => SessionEvent.parse(base)).toThrow();
  });

  test("negative seq rejected", () => {
    expect(() => SessionEvent.parse({ ...base, seq: -1, type: "session_created", scope: "g" })).toThrow();
  });

  test("agent event variants parse", () => {
    const t = { ...base, threadId: "main" };
    const events = [
      { ...t, type: "turn_started" },
      { ...t, type: "assistant_message", text: "done!" },
      { ...t, type: "tool_call", callId: "c1", name: "read", argsJson: "{}" },
      { ...t, type: "tool_result", callId: "c1", output: "contents", isError: false },
      { ...t, type: "approval_requested", callId: "c2", toolName: "write", summary: "write hello.txt (24 bytes)" },
      { ...t, type: "approval_resolved", callId: "c2", approved: true, by: "cli-p" },
      { ...t, type: "turn_completed", stopReason: "end_turn", inputTokens: 100, outputTokens: 20 },
      { ...t, type: "agent_error", message: "not signed in" },
    ] as const;
    for (const e of events) expect(SessionEvent.parse(e).type).toBe(e.type);
  });

  test("assistant_delta parses; empty delta rejected", () => {
    const e = { ...base, threadId: "main", type: "assistant_delta", delta: "wor" } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(() => SessionEvent.parse({ ...base, threadId: "main", type: "assistant_delta", delta: "" })).toThrow();
  });

  test("directory_added variant parses", () => {
    const e = { ...base, threadId: "main", type: "directory_added", path: "/opt/data", persisted: true };
    expect(SessionEvent.parse(e)).toMatchObject({ type: "directory_added", path: "/opt/data", persisted: true });
  });

  test("bg_task_* variants parse", () => {
    for (const e of [
      { ...base, threadId: "main", type: "bg_task_started", taskId: "bg_a1", command: "sleep 5" },
      { ...base, threadId: "main", type: "bg_task_output", taskId: "bg_a1", chunk: "line1\n" },
      { ...base, threadId: "main", type: "bg_task_exited", taskId: "bg_a1", exitCode: 0, killed: false },
      { ...base, threadId: "main", type: "bg_task_exited", taskId: "bg_a1", exitCode: null, killed: true },
    ]) {
      expect(SessionEvent.parse(e).type).toBe(e.type as SessionEvent["type"]);
    }
  });

  test("tool_result caps are enforced by schema shape only (output is plain string)", () => {
    const e = { ...base, threadId: "main", type: "tool_result", callId: "c", output: "x".repeat(100), isError: true };
    expect(SessionEvent.parse(e)).toMatchObject({ isError: true });
  });

  test("checkpoint event parses", () => {
    const e = SessionEvent.parse({ seq: 3, ts: 1781270000000, sessionId: "s_x", type: "checkpoint", threadId: "main", summary: "did X, decided Y", uptoSeq: 2 });
    expect(e.type).toBe("checkpoint" as SessionEvent["type"]);
    if (e.type === "checkpoint") { expect(e.uptoSeq).toBe(2); expect(e.summary).toContain("decided Y"); }
  });

  test("question_asked / question_resolved / task_updated round-trip", () => {
    const qa = {
      type: "question_asked" as const, sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c1",
      questions: [
        { question: "Which codename?", header: "Codename", options: [{ label: "Falcon" }, { label: "Osprey", description: "the bird" }], multiSelect: false },
        { question: "Which features?", header: "Features", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true },
      ],
    };
    expect(SessionEvent.parse(qa)).toEqual(qa);

    const qr = {
      type: "question_resolved", sessionId: "s", threadId: "t", seq: 2, ts: 2, callId: "c1",
      answers: { "Which codename?": "Osprey" }, by: "cli",
    } as const;
    expect(SessionEvent.parse(qr)).toEqual(qr);

    const tu = {
      type: "task_updated", sessionId: "s", threadId: "t", seq: 3, ts: 3,
      task: { id: "1", subject: "rename", status: "pending" },
    } as const;
    expect(SessionEvent.parse(tu)).toEqual(tu);
  });

  test("bounds: 0/5 questions, 1/5 options, 13-char header rejected", () => {
    const t = { seq: 1, sessionId: "s", ts: 1, threadId: "t" };
    const validQuestion = { question: "Q?", header: "Header", options: [{ label: "A" }, { label: "B" }], multiSelect: false };

    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [] }).success).toBe(false); // 0 questions
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: Array(5).fill(validQuestion) }).success).toBe(false); // 5 questions
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [validQuestion] }).success).toBe(true); // 1 question ok
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, options: [{ label: "A" }] }] }).success).toBe(false); // 1 option
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, options: Array(5).fill({ label: "A" }) }] }).success).toBe(false); // 5 options
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, header: "H".repeat(13) }] }).success).toBe(false); // 13-char header
    expect(SessionEvent.safeParse({ ...t, type: "question_asked", callId: "c", questions: [{ ...validQuestion, header: "H".repeat(12) }] }).success).toBe(true); // 12-char header ok
  });

  test("plan_presented / plan_resolved round-trip", () => {
    const pp = { type: "plan_presented", sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c1", plan: "# Plan\n1. do X" } as const;
    expect(SessionEvent.parse(pp)).toEqual(pp);
    const pr = { type: "plan_resolved", sessionId: "s", threadId: "t", seq: 2, ts: 2, callId: "c1", approved: true, feedback: "looks good", autoAccept: true, by: "cli" } as const;
    expect(SessionEvent.parse(pr)).toEqual(pr);
  });

  test("plan_presented requires a non-empty plan", () => {
    expect(SessionEvent.safeParse({ type: "plan_presented", sessionId: "s", threadId: "t", seq: 1, ts: 1, callId: "c", plan: "" }).success).toBe(false);
  });

  test("worktree_entered / worktree_exited round-trip", () => {
    const we = { type: "worktree_entered", sessionId: "s", threadId: "t", seq: 1, ts: 1, name: "fix-auth", path: "/repo/.norma/worktrees/fix-auth", branch: "norma/fix-auth" } as const;
    expect(SessionEvent.parse(we)).toEqual(we);
    const wx = { type: "worktree_exited", sessionId: "s", threadId: "t", seq: 2, ts: 2, name: "fix-auth", action: "keep", removed: false } as const;
    expect(SessionEvent.parse(wx)).toEqual(wx);
  });

  test("worktree_entered rejects empty name/path/branch; worktree_exited rejects bad action", () => {
    const t = { sessionId: "s", threadId: "t", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "", path: "/p", branch: "b" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "n", path: "", branch: "b" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_entered", name: "n", path: "/p", branch: "" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "worktree_exited", name: "n", action: "delete", removed: false }).success).toBe(false);
  });

  test("thread_started / thread_completed round-trip", () => {
    const ts = { type: "thread_started", sessionId: "s", threadId: "th_child1", seq: 1, ts: 1, parentThreadId: "main", agentType: "researcher", prompt: "Summarize the auth module" } as const;
    expect(SessionEvent.parse(ts)).toEqual(ts);
    const tc = { type: "thread_completed", sessionId: "s", threadId: "th_child1", seq: 2, ts: 2, stopReason: "end_turn" } as const;
    expect(SessionEvent.parse(tc)).toEqual(tc);
  });

  test("thread_started rejects empty parentThreadId; thread_completed rejects bad stopReason", () => {
    const t = { sessionId: "s", threadId: "th_child1", seq: 1, ts: 1 };
    expect(SessionEvent.safeParse({ ...t, type: "thread_started", parentThreadId: "", agentType: "researcher", prompt: "x" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "thread_completed", stopReason: "bogus" }).success).toBe(false);
  });

  test("lease_granted / lease_lost / peripheral_call_requested round-trip", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "session" as const, id: "s" };

    const granted = { ...t, type: "lease_granted", leaseId: "lease_1", class: "screenshot", holder, expiresAt: 20 } as const;
    expect(SessionEvent.parse(granted)).toEqual(granted);

    const lost = { ...t, type: "lease_lost", leaseId: "lease_1", class: "screenshot", holder, reason: "expired" } as const;
    expect(SessionEvent.parse(lost)).toEqual(lost);

    const called = { ...t, type: "peripheral_call_requested", requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}" } as const;
    expect(SessionEvent.parse(called)).toEqual(called);
  });

  test("lease events reject unknown class, unknown holder kind, unknown lease_lost reason", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "session", id: "s" };
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "bogus", holder, expiresAt: 1 }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: "noop", holder: { kind: "bogus", id: "s" }, expiresAt: 1 }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...t, type: "lease_lost", leaseId: "l", class: "noop", holder, reason: "bogus" }).success).toBe(false);
    for (const reason of ["expired", "released", "panic", "revoked", "provider-gone"]) {
      expect(SessionEvent.safeParse({ ...t, type: "lease_lost", leaseId: "l", class: "noop", holder, reason }).success).toBe(true);
    }
  });

  test("all four peripheral classes accepted: screenshot, ax-read, input-drive, noop", () => {
    const t = { sessionId: "s", threadId: "main", seq: 1, ts: 1 };
    const holder = { kind: "plugin" as const, id: "p_1" };
    for (const cls of ["screenshot", "ax-read", "input-drive", "noop"]) {
      expect(SessionEvent.safeParse({ ...t, type: "lease_granted", leaseId: "l", class: cls, holder, expiresAt: 1 }).success).toBe(true);
    }
  });
});

describe("hello method schemas", () => {
  test("valid hello", () => {
    const p = { protocolVersion: PROTOCOL_VERSION, role: "harness", token: "t", clientName: "test" } as const;
    expect(HelloParams.parse(p).role).toBe("harness");
    expect(HelloResult.parse({ ok: true, serverVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION }).ok).toBe(true);
  });

  test("unknown role rejected", () => {
    expect(() => HelloParams.parse({ protocolVersion: 0, role: "root", token: "t", clientName: "x" })).toThrow();
  });
});
