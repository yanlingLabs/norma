import { describe, expect, test } from "bun:test";
import {
  SessionAttachParams,
  SessionListResult,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  ApprovalRespondParams,
  ApprovalRespondResult,
  SessionAddDirParams,
  SessionSetCwdParams,
  TrustDirParams,
  TrustDirResult,
  BgListParams,
  BgPeekParams,
  BgKillParams,
  BgKillAllParams,
  BgListResult,
  SessionSteerParams,
  SessionInterruptParams,
  SessionSteerResult,
  SessionInterruptResult,
  SessionCompactParams,
  SessionCompactResult,
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

describe("SessionCreateResult.trusted", () => {
  test("SessionCreateResult carries trusted", () => {
    expect(SessionCreateResult.parse({ sessionId: "s1", trusted: false }).trusted).toBe(false);
    expect(() => SessionCreateResult.parse({ sessionId: "s1" })).toThrow(); // trusted now required
  });
});

describe("daemon.trustDir", () => {
  test("daemon.trustDir params/result + method string", () => {
    expect(TrustDirParams.parse({ path: "/Users/x/proj" }).path).toBe("/Users/x/proj");
    expect(() => TrustDirParams.parse({ path: "rel" })).toThrow();   // must be absolute
    expect(() => TrustDirParams.parse({ path: "/" })).toThrow();     // reject filesystem root
    expect(TrustDirResult.parse({ ok: true, trusted: true }).trusted).toBe(true);
    expect(METHODS.trustDir).toBe("daemon.trustDir");
  });
});

describe("cwd '/' rejection", () => {
  test("cwd '/' is rejected for create and setCwd (whole-fs guard)", () => {
    expect(() => SessionCreateParams.parse({ scope: "global", cwd: "/" })).toThrow();
    expect(() => SessionSetCwdParams.parse({ sessionId: "s1", cwd: "/" })).toThrow();
    expect(SessionCreateParams.parse({ scope: "global", cwd: "/Users/x" }).cwd).toBe("/Users/x");
  });
});

describe("bg.* method schemas", () => {
  test("bg.* method schemas", () => {
    expect(BgListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(BgPeekParams.parse({ sessionId: "s1", taskId: "bg_a" }).taskId).toBe("bg_a");
    expect(BgKillParams.parse({ sessionId: "s1", taskId: "bg_a" }).taskId).toBe("bg_a");
    expect(BgKillAllParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(BgListResult.parse({ tasks: [{ taskId: "bg_a", command: "sleep 5", status: "running", exitCode: null, startedAt: 1 }] }).tasks).toHaveLength(1);
    expect([METHODS.bgList, METHODS.bgPeek, METHODS.bgKill, METHODS.bgKillAll]).toEqual(["bg.list", "bg.peek", "bg.kill", "bg.killAll"]);
  });
});

describe("session.steer / session.interrupt schemas", () => {
  test("session.steer / session.interrupt schemas", () => {
    expect(SessionSteerParams.parse({ sessionId: "s1", text: "hi" }).text).toBe("hi");
    expect(() => SessionSteerParams.parse({ sessionId: "s1", text: "" })).toThrow();
    expect(SessionSteerResult.parse({ ok: true, injected: true }).injected).toBe(true);
    expect(SessionInterruptParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(SessionInterruptResult.parse({ ok: true, wasRunning: false }).wasRunning).toBe(false);
    expect([METHODS.sessionSteer, METHODS.sessionInterrupt]).toEqual(["session.steer", "session.interrupt"]);
  });
});

describe("session.compact schema", () => {
  test("session.compact params/result + method string", () => {
    expect(SessionCompactParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(() => SessionCompactParams.parse({ sessionId: "" })).toThrow();
    const r = SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: 12, summaryChars: 340 });
    expect(r).toEqual({ ok: true, compacted: true, uptoSeq: 12, summaryChars: 340 });
    expect(() => SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: -1, summaryChars: 0 })).toThrow();
    expect(() => SessionCompactResult.parse({ ok: true, compacted: true, uptoSeq: 0, summaryChars: -1 })).toThrow();
    expect(METHODS.sessionCompact).toBe("session.compact");
  });
});
