import { describe, expect, test } from "bun:test";
import {
  SessionAttachParams,
  SessionListResult,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  ApprovalRespondParams,
  ApprovalRespondResult,
  ApprovalPolicy,
  AskUserRespondParams,
  AskUserRespondResult,
  TaskListParams,
  TaskListResult,
  PlanRespondParams,
  PlanRespondResult,
  SessionSetPolicyParams,
  SessionSetPolicyResult,
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
  ThreadInfoSchema,
  ThreadListParams,
  ThreadListResult,
  PeripheralLeaseParams,
  PeripheralLeaseResult,
  PeripheralRenewParams,
  PeripheralRenewResult,
  PeripheralReleaseParams,
  PeripheralReleaseResult,
  PeripheralAdvertiseParams,
  PeripheralAdvertiseResult,
  PeripheralRevokeParams,
  PeripheralRevokeResult,
  PeripheralRespondParams,
  PeripheralRespondResult,
  DaemonStatusParams,
  DaemonStatusResult,
  QuotaStateParams,
  QuotaStateResult,
  TrustListParams,
  TrustListResult,
  TrustRemoveParams,
  TrustRemoveResult,
  PluginRegisterParams,
  PluginRegisterResult,
  ToolRegisterParams,
  ToolRegisterResult,
  ShortcutRegisterParams,
  ShortcutRegisterResult,
  TileUpdateParams,
  TileUpdateResult,
  ProviderRegisterParams,
  ProviderRegisterResult,
  PluginToolResultParams,
  PluginToolResultResult,
  PluginRevokeTokenParams,
  PluginRevokeTokenResult,
  PluginRestartParams,
  PluginRestartResult,
  HardwareRequestParams,
  HardwareRequestResult,
  HardwareRespondParams,
  HardwareRespondResult,
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

  test("Phase 4a Task 3: consent-flow fields (tier/requiredConsents/consented/legacy/execPayload/tccPermissions/hardwarePermissions) round-trip", () => {
    const info = PluginInfoSchema.parse({
      name: "demo", skills: [], hasMcp: false, mcpEnabled: true, disabled: false,
      tier: "platform", requiredConsents: ["exec", "tcc", "hardware"], consented: ["exec"], legacy: false,
      execPayload: ["mcp: node server.js", "entry: node index.js"],
      tccPermissions: ["accessibility"], hardwarePermissions: ["battery"],
    });
    expect(info).toMatchObject({
      tier: "platform", requiredConsents: ["exec", "tcc", "hardware"], consented: ["exec"], legacy: false,
      execPayload: ["mcp: node server.js", "entry: node index.js"],
      tccPermissions: ["accessibility"], hardwarePermissions: ["battery"],
    });
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

describe("plan.respond / session.setPolicy schemas", () => {
  test("ApprovalPolicy accepts plan; plan.respond + session.setPolicy params parse", () => {
    expect(ApprovalPolicy.parse("plan")).toBe("plan");
    expect(PlanRespondParams.parse({ sessionId: "s", callId: "c", approved: false }).autoAccept).toBe(false); // default
    expect(SessionSetPolicyParams.parse({ sessionId: "s", policy: "plan" }).policy).toBe("plan");
  });

  test("plan.respond params/result + method string", () => {
    const p = PlanRespondParams.parse({ sessionId: "s1", callId: "c1", approved: true, feedback: "looks good", autoAccept: true });
    expect(p).toEqual({ sessionId: "s1", callId: "c1", approved: true, feedback: "looks good", autoAccept: true });
    expect(PlanRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
    expect(METHODS.planRespond).toBe("plan.respond");
  });

  test("session.setPolicy params/result + method string", () => {
    expect(SessionSetPolicyParams.parse({ sessionId: "s1", policy: "auto" }).policy).toBe("auto");
    expect(() => SessionSetPolicyParams.parse({ sessionId: "s1", policy: "bogus" })).toThrow();
    expect(SessionSetPolicyResult.parse({ ok: true }).ok).toBe(true);
    expect(METHODS.sessionSetPolicy).toBe("session.setPolicy");
  });
});

describe("peripheral lease + dashboard read methods", () => {
  test("METHODS carries the six peripheral verbs + four dashboard read methods", () => {
    expect(METHODS.peripheralLease).toBe("peripheral.lease");
    expect(METHODS.peripheralRenew).toBe("peripheral.renew");
    expect(METHODS.peripheralRelease).toBe("peripheral.release");
    expect(METHODS.peripheralAdvertise).toBe("peripheral.advertise");
    expect(METHODS.peripheralRevoke).toBe("peripheral.revoke");
    expect(METHODS.peripheralRespond).toBe("peripheral.respond");
    expect(METHODS.daemonStatus).toBe("daemon.status");
    expect(METHODS.quotaState).toBe("quota.state");
    expect(METHODS.trustList).toBe("trust.list");
    expect(METHODS.trustRemove).toBe("trust.remove");
  });

  test("peripheral.lease params/result: class enum + grant/held/no_provider/denied variants", () => {
    expect(PeripheralLeaseParams.parse({ sessionId: "s1", class: "noop" }).class).toBe("noop");
    expect(() => PeripheralLeaseParams.parse({ sessionId: "s1", class: "bogus" })).toThrow();
    const granted = PeripheralLeaseResult.parse({ leaseId: "l1", token: "t1", expiresAt: 100 });
    expect("leaseId" in granted && granted.leaseId).toBe("l1");
    expect(PeripheralLeaseResult.parse({ code: "lease_held", holder: { kind: "session", id: "s2" } })).toEqual({
      code: "lease_held", holder: { kind: "session", id: "s2" },
    });
    expect(PeripheralLeaseResult.parse({ code: "no_provider" })).toEqual({ code: "no_provider" });
    expect(PeripheralLeaseResult.parse({ code: "denied" })).toEqual({ code: "denied" });
    const pluginDenied = PeripheralLeaseResult.parse({ code: "denied", reason: "plugin-leasing-not-yet-available" });
    expect("reason" in pluginDenied && pluginDenied.reason).toBe("plugin-leasing-not-yet-available");
    expect(() => PeripheralLeaseResult.parse({ code: "bogus" })).toThrow();
  });

  test("peripheral.renew / peripheral.release params/result", () => {
    const rp = PeripheralRenewParams.parse({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(rp).toEqual({ sessionId: "s1", leaseId: "l1", token: "t1" });
    const renewed = PeripheralRenewResult.parse({ ok: true, expiresAt: 200 });
    expect("expiresAt" in renewed && renewed.expiresAt).toBe(200);
    expect(PeripheralRenewResult.parse({ code: "not_found" })).toEqual({ code: "not_found" });
    expect(PeripheralRenewResult.parse({ code: "token_mismatch" })).toEqual({ code: "token_mismatch" });
    // L1 fix: renew() rejects a lease past expiresAt (pre-sweep window) instead of resurrecting it.
    expect(PeripheralRenewResult.parse({ code: "expired" })).toEqual({ code: "expired" });
    const renewDenied = PeripheralRenewResult.parse({ code: "denied", reason: "plugin-leasing-not-yet-available" });
    expect("code" in renewDenied && renewDenied.code).toBe("denied");

    const relp = PeripheralReleaseParams.parse({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(relp).toEqual({ sessionId: "s1", leaseId: "l1", token: "t1" });
    expect(PeripheralReleaseResult.parse({ ok: true })).toEqual({ ok: true });
    expect(PeripheralReleaseResult.parse({ code: "not_found" })).toEqual({ code: "not_found" });
  });

  test("peripheral.advertise / peripheral.revoke / peripheral.respond params/result", () => {
    const ap = PeripheralAdvertiseParams.parse({ classes: [{ class: "noop", tccGranted: true }] });
    expect(ap.classes).toHaveLength(1);
    expect(PeripheralAdvertiseResult.parse({ ok: true })).toEqual({ ok: true });

    expect(PeripheralRevokeParams.parse({ all: true, reason: "panic" })).toEqual({ all: true, reason: "panic" });
    expect(PeripheralRevokeParams.parse({ leaseId: "l1", reason: "revoked" }).leaseId).toBe("l1");
    expect(() => PeripheralRevokeParams.parse({ all: true, reason: "bogus" })).toThrow();
    expect(PeripheralRevokeResult.parse({ ok: true, revoked: 2 }).revoked).toBe(2);

    expect(PeripheralRespondParams.parse({ requestId: "r1", resultJson: "{}" }).requestId).toBe("r1");
    expect(PeripheralRespondParams.parse({ requestId: "r1", error: "boom" }).error).toBe("boom");
    expect(PeripheralRespondResult.parse({ ok: true, alreadyResolved: false }).alreadyResolved).toBe(false);
  });

  test("daemon.status / quota.state shapes", () => {
    expect(DaemonStatusParams.parse({})).toEqual({});
    const status = DaemonStatusResult.parse({
      version: "0.0.1", uptimeMs: 1234, socketPath: "/tmp/core.sock",
      provider: { id: "fake", model: "fake-1" }, sessionsCount: 2, pluginsCount: 0,
    });
    expect(status.provider?.id).toBe("fake");
    expect(DaemonStatusResult.parse({
      version: "0.0.1", uptimeMs: 0, socketPath: "/tmp/core.sock",
      provider: null, sessionsCount: 0, pluginsCount: 0,
    }).provider).toBeNull();

    expect(QuotaStateParams.parse({})).toEqual({});
    expect(QuotaStateResult.parse({ kind: "ok", inputTokens: 0, outputTokens: 0 }).kind).toBe("ok");
    const limited = QuotaStateResult.parse({ kind: "limited", resumeAt: 999, inputTokens: 5, outputTokens: 6 });
    expect(limited.resumeAt).toBe(999);
  });

  test("trust.list / trust.remove params/result", () => {
    expect(TrustListParams.parse({})).toEqual({});
    expect(TrustListResult.parse({ dirs: ["/a", "/b"] }).dirs).toHaveLength(2);
    expect(TrustRemoveParams.parse({ path: "/a" }).path).toBe("/a");
    expect(() => TrustRemoveParams.parse({ path: "rel" })).toThrow();
    expect(TrustRemoveResult.parse({ removed: true }).removed).toBe(true);
  });
});

describe("thread.list schema", () => {
  test("thread.list params/result + method string", () => {
    expect(ThreadListParams.parse({ sessionId: "s1" }).sessionId).toBe("s1");
    expect(() => ThreadListParams.parse({ sessionId: "" })).toThrow();
    const info = ThreadInfoSchema.parse({ threadId: "th_child1", parentThreadId: "main", agentType: "researcher", status: "running" });
    expect(info.status).toBe("running");
    // parentThreadId/agentType/stopReason are optional
    expect(ThreadInfoSchema.parse({ threadId: "main", status: "completed" }).parentThreadId).toBeUndefined();
    expect(() => ThreadInfoSchema.parse({ threadId: "t", status: "bogus" })).toThrow();
    const r = ThreadListResult.parse({ ok: true, threads: [info] });
    expect(r.threads).toHaveLength(1);
    expect(METHODS.threadList).toBe("thread.list");
  });
});

describe("plugin verbs (Phase 4b Task 1, spec §3)", () => {
  test("METHODS carries the six plugin verbs", () => {
    expect(METHODS.pluginRegister).toBe("plugin.register");
    expect(METHODS.toolRegister).toBe("tool.register");
    expect(METHODS.shortcutRegister).toBe("shortcut.register");
    expect(METHODS.tileUpdate).toBe("tile.update");
    expect(METHODS.providerRegister).toBe("provider.register");
    expect(METHODS.pluginToolResult).toBe("plugin.toolResult");
  });

  test("plugin.register params/result", () => {
    expect(PluginRegisterParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRegisterParams.parse({ pluginId: "" })).toThrow();
    expect(PluginRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("tool.register params/result: parameters optional, registeredAs required in result", () => {
    const bare = ToolRegisterParams.parse({ name: "echo", description: "Echo the input back" });
    expect(bare.parameters).toBeUndefined();
    const withParams = ToolRegisterParams.parse({
      name: "echo", description: "Echo the input back",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    expect(withParams.parameters).toMatchObject({ type: "object" });
    expect(() => ToolRegisterParams.parse({ name: "", description: "x" })).toThrow();
    expect(() => ToolRegisterParams.parse({ name: "echo", description: "" })).toThrow();
    expect(ToolRegisterResult.parse({ ok: true, registeredAs: "plugin__sample-echo__echo" }).registeredAs)
      .toBe("plugin__sample-echo__echo");
    expect(() => ToolRegisterResult.parse({ ok: true, registeredAs: "" })).toThrow();
  });

  test("tool.register name charset (final-review Fix 3): alphanumeric + single -/_ separators only — no __, no leading/trailing _, no other punctuation", () => {
    for (const ok of ["echo", "read-file", "read_file", "a1-b2_c3", "UPPER", "123"]) {
      expect(ToolRegisterParams.parse({ name: ok, description: "d" }).name).toBe(ok);
    }
    for (const bad of ["read__file", "_leading", "trailing_", "__", "has space", "has.dot", "has/slash", "emoji🎉"]) {
      expect(() => ToolRegisterParams.parse({ name: bad, description: "d" })).toThrow();
    }
  });

  test("shortcut.register params/result: description/default optional, id required", () => {
    const p = ShortcutRegisterParams.parse({
      shortcuts: [{ id: "toggle-limiter" }, { id: "boost", description: "Boost charging", default: "cmd+shift+b" }],
    });
    expect(p.shortcuts).toHaveLength(2);
    expect(p.shortcuts[0]!.description).toBeUndefined();
    expect(p.shortcuts[1]!.default).toBe("cmd+shift+b");
    expect(() => ShortcutRegisterParams.parse({ shortcuts: [{ id: "" }] })).toThrow();
    expect(ShortcutRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("tile.update params/result: tile is an opaque record", () => {
    const p = TileUpdateParams.parse({ tile: { title: "Charge Limit", value: "80%", progress: 0.8 } });
    expect(p.tile).toMatchObject({ title: "Charge Limit" });
    expect(TileUpdateResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("provider.register params/result: reserved-minimal, info is an opaque record", () => {
    const p = ProviderRegisterParams.parse({ info: { id: "local-models", model: "llama-3" } });
    expect(p.info).toMatchObject({ id: "local-models" });
    expect(ProviderRegisterResult.parse({ ok: true })).toEqual({ ok: true });
  });

  test("plugin.toolResult params/result: mirrors peripheral.respond's shape minus alreadyResolved", () => {
    expect(PluginToolResultParams.parse({ requestId: "req_1", resultJson: "{\"echo\":\"hi\"}" }).requestId).toBe("req_1");
    expect(PluginToolResultParams.parse({ requestId: "req_1", error: "plugin sample-echo crashed during echo" }).error)
      .toBe("plugin sample-echo crashed during echo");
    expect(() => PluginToolResultParams.parse({ requestId: "" })).toThrow();
    expect(PluginToolResultResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("plugin.revokeToken (Phase 4b Task 2, spec §3 — harness-role admin verb, NOT one of the six plugin verbs)", () => {
  test("METHODS carries it; params require a non-empty pluginId; result is a plain ok", () => {
    expect(METHODS.pluginRevokeToken).toBe("plugin.revokeToken");
    expect(PluginRevokeTokenParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRevokeTokenParams.parse({ pluginId: "" })).toThrow();
    expect(() => PluginRevokeTokenParams.parse({})).toThrow();
    expect(PluginRevokeTokenResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("plugin.restart (final-review Fix 1 — restart rider, recovers a circuit-open plugin; harness/admin role like plugins.list, NOT one of the six plugin verbs)", () => {
  test("METHODS carries it; params require a non-empty pluginId; result is a plain ok", () => {
    expect(METHODS.pluginRestart).toBe("plugin.restart");
    expect(PluginRestartParams.parse({ pluginId: "sample-echo" }).pluginId).toBe("sample-echo");
    expect(() => PluginRestartParams.parse({ pluginId: "" })).toThrow();
    expect(() => PluginRestartParams.parse({})).toThrow();
    expect(PluginRestartResult.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe("hardware.request / hardware.respond (Phase 4c Task 1, spec §5)", () => {
  test("METHODS carries both verbs", () => {
    expect(METHODS.hardwareRequest).toBe("hardware.request");
    expect(METHODS.hardwareRespond).toBe("hardware.respond");
  });

  test("hardware.request params: verb required, argsJson optional", () => {
    expect(HardwareRequestParams.parse({ verb: "setChargeLimit", argsJson: '{"percent":80}' }).verb).toBe("setChargeLimit");
    const bare = HardwareRequestParams.parse({ verb: "getChargeLimit" });
    expect(bare.argsJson).toBeUndefined();
    expect(() => HardwareRequestParams.parse({ verb: "" })).toThrow();
    expect(() => HardwareRequestParams.parse({})).toThrow();
  });

  // Task 2 review pin (binding): widened from a bare {resultJson} object to a success|error-code
  // union mirroring PeripheralLeaseResult — see methods.ts's HardwareRequestResult doc comment.
  test("hardware.request result: success|unknown_verb|consent_denied|no_provider|timeout|provider_error union", () => {
    const success = HardwareRequestResult.parse({ resultJson: "{\"percent\":80}" });
    expect("resultJson" in success && success.resultJson).toBe("{\"percent\":80}");
    expect(() => HardwareRequestResult.parse({})).toThrow();

    expect(HardwareRequestResult.parse({ code: "unknown_verb" })).toEqual({ code: "unknown_verb" });

    expect(HardwareRequestResult.parse({ code: "consent_denied" })).toEqual({ code: "consent_denied" });
    expect(HardwareRequestResult.parse({ code: "consent_denied", missing: "battery" })).toEqual({
      code: "consent_denied", missing: "battery",
    });

    expect(HardwareRequestResult.parse({ code: "no_provider", message: "hardware features require Norma.app" })).toEqual({
      code: "no_provider", message: "hardware features require Norma.app",
    });
    expect(() => HardwareRequestResult.parse({ code: "no_provider" })).toThrow(); // message is required

    expect(HardwareRequestResult.parse({ code: "timeout" })).toEqual({ code: "timeout" });

    expect(HardwareRequestResult.parse({ code: "provider_error", message: "unsupported_value" })).toEqual({
      code: "provider_error", message: "unsupported_value",
    });
    expect(() => HardwareRequestResult.parse({ code: "provider_error" })).toThrow(); // message is required

    expect(() => HardwareRequestResult.parse({ code: "bogus" })).toThrow();
  });

  test("hardware.respond params/result: mirrors peripheral.respond's shape minus alreadyResolved, same precedent as plugin.toolResult", () => {
    expect(HardwareRespondParams.parse({ requestId: "req_1", resultJson: "{\"percent\":80}" }).requestId).toBe("req_1");
    expect(HardwareRespondParams.parse({ requestId: "req_1", error: "unsupported_value" }).error).toBe("unsupported_value");
    expect(() => HardwareRespondParams.parse({ requestId: "" })).toThrow();
    expect(HardwareRespondResult.parse({ ok: true })).toEqual({ ok: true });
  });
});
