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
      expect(SessionEvent.parse(e).type).toBe(e.type);
    }
  });

  test("tool_result caps are enforced by schema shape only (output is plain string)", () => {
    const e = { ...base, threadId: "main", type: "tool_result", callId: "c", output: "x".repeat(100), isError: true };
    expect(SessionEvent.parse(e)).toMatchObject({ isError: true });
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
