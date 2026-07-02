import { describe, expect, test } from "bun:test";
import {
  SessionAttachParams,
  SessionListResult,
  SessionAttachResult,
  SessionCreateParams,
  ApprovalRespondParams,
  ApprovalRespondResult,
  SessionAddDirParams,
  SessionSetCwdParams,
  METHODS,
} from "../src/methods";

describe("SessionAttachParams", () => {
  test("fromSeq defaults to 0 when omitted", () => {
    const result = SessionAttachParams.parse({ sessionId: "abc" });
    expect(result.fromSeq).toBe(0);
  });
});

describe("lastSeq nonnegative", () => {
  test("SessionListResult rejects negative lastSeq", () => {
    expect(() =>
      SessionListResult.parse({
        sessions: [
          { sessionId: "s1", scope: "foo", createdAt: 0, lastSeq: -1 },
        ],
      })
    ).toThrow();
  });

  test("SessionAttachResult rejects negative lastSeq", () => {
    expect(() =>
      SessionAttachResult.parse({ ok: true, lastSeq: -1 })
    ).toThrow();
  });
});

describe("scope regex", () => {
  test('"abc-" rejected (trailing hyphen)', () => {
    expect(() => SessionCreateParams.parse({ scope: "abc-" })).toThrow();
  });

  test('"a" accepted (single char)', () => {
    expect(SessionCreateParams.parse({ scope: "a" }).scope).toBe("a");
  });

  test('"a--b" accepted (consecutive interior hyphens are fine)', () => {
    expect(SessionCreateParams.parse({ scope: "a--b" }).scope).toBe("a--b");
  });

  test("41-char scope accepted", () => {
    // slug: no leading/trailing hyphen, ≤41 chars
    const slug = "a" + "b".repeat(39) + "c"; // 41 chars
    expect(SessionCreateParams.parse({ scope: slug }).scope).toBe(slug);
  });

  test("42-char scope rejected", () => {
    const slug = "a" + "b".repeat(40) + "c"; // 42 chars
    expect(() => SessionCreateParams.parse({ scope: slug })).toThrow();
  });
});

describe("agent method schemas", () => {
  test("approval.respond params/result", () => {
    const p = ApprovalRespondParams.parse({ sessionId: "s_1", callId: "c1", approved: false });
    expect(p.approved).toBe(false);
    expect(ApprovalRespondResult.parse({ ok: true, alreadyResolved: false }).ok).toBe(true);
    expect(METHODS.approvalRespond).toBe("approval.respond");
  });

  test("session.create accepts optional cwd (absolute) and approvalPolicy", () => {
    const p = SessionCreateParams.parse({ scope: "global", cwd: "/tmp/x", approvalPolicy: "auto" });
    expect(p.approvalPolicy).toBe("auto");
    expect(SessionCreateParams.parse({ scope: "global" }).approvalPolicy).toBe("ask");
    expect(() => SessionCreateParams.parse({ scope: "global", cwd: "relative/path" })).toThrow();
  });
});

describe("directory method schemas", () => {
  test("session.addDir / session.setCwd params", () => {
    expect(SessionAddDirParams.parse({ sessionId: "s1", path: "/x", persist: true }).persist).toBe(true);
    expect(SessionAddDirParams.parse({ sessionId: "s1", path: "/x" }).persist).toBe(false);
    expect(() => SessionSetCwdParams.parse({ sessionId: "s1", cwd: "rel" })).toThrow();
    expect(SessionSetCwdParams.parse({ sessionId: "s1", cwd: "/abs" }).cwd).toBe("/abs");
    expect(METHODS.sessionAddDir).toBe("session.addDir");
    expect(METHODS.sessionSetCwd).toBe("session.setCwd");
  });
});
