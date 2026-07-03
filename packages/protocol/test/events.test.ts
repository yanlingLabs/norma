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
