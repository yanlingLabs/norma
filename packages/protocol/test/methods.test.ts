import { describe, expect, test } from "bun:test";
import {
  SessionAttachParams,
  SessionListResult,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  ApprovalRespondParams,
  ApprovalRespondResult,
  AskUserRespondParams,
  AskUserRespondResult,
  TaskListParams,
  TaskListResult,
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
  SkillMetaSchema,
  SkillsListParams,
  SkillsListResult,
  McpServerStatusSchema,
  PluginInfoSchema,
  PluginsListParams,
  PluginsListResult,
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

describe("skills.list schema", () => {
  test("skills.list params/result + method string", () => {
    expect(SkillsListParams.parse({}).cwd).toBeUndefined();
    expect(SkillsListParams.parse({ cwd: "/tmp/x" }).cwd).toBe("/tmp/x");
    const meta = SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "user", path: "/x/SKILL.md" });
    expect(meta.source).toBe("user");
    expect(() => SkillMetaSchema.parse({ name: "greet", description: "Say hi", source: "bogus", path: "/x" })).toThrow();
    const r = SkillsListResult.parse({ ok: true, skills: [meta] });
    expect(r.skills).toHaveLength(1);
    expect(METHODS.skillsList).toBe("skills.list");
  });
});

describe("plugins.list schema", () => {
  test("plugins.list params/result + method string", () => {
    expect(PluginsListParams.parse({})).toEqual({});
    const info = PluginInfoSchema.parse({
      name: "demo", description: "d", version: "0.1.0",
      skills: ["greet"], hasMcp: true, mcpEnabled: false, disabled: false,
    });
    expect(info.name).toBe("demo");
    // description/version are optional
    expect(PluginInfoSchema.parse({ name: "bare", skills: [], hasMcp: false, mcpEnabled: false, disabled: false }).description).toBeUndefined();
    const r = PluginsListResult.parse({ ok: true, plugins: [info] });
    expect(r.plugins).toHaveLength(1);
    expect(METHODS.pluginsList).toBe("plugins.list");
  });

  test("McpServerStatusSchema.source is widened to include \"plugin\"", () => {
    expect(McpServerStatusSchema.parse({ name: "x", status: "connected", toolNames: [], source: "plugin" }).source).toBe("plugin");
  });
});

describe("ask_user.respond / task.list schemas", () => {
  test("ask_user.respond params/result + method string", () => {
    const p = AskUserRespondParams.parse({ sessionId: "s1", callId: "c1", answers: { "Which codename?": "Falcon" } });
    expect(p.answers["Which codename?"]).toBe("Falcon");
    expect(AskUserRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
    expect(METHODS.askUserRespond).toBe("ask_user.respond");
  });

  test("task.list params/result + method string", () => {
    expect(TaskListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    const r = TaskListResult.parse({ ok: true, tasks: [{ id: "1", subject: "rename", status: "pending" }] });
    expect(r.tasks).toHaveLength(1);
    expect(() => TaskListResult.parse({ ok: true, tasks: [{ id: "1", subject: "rename", status: "bogus" }] })).toThrow();
    expect(METHODS.taskList).toBe("task.list");
  });
});
