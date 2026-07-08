import { z } from "zod";
import { SessionEvent, TaskSchema, PeripheralClassSchema, HolderSchema } from "./events";

export const PROTOCOL_VERSION = 0;

/** An absolute directory path that is not the filesystem root (guards against a whole-fs writable fence). */
export const AbsoluteDirPath = z.string().startsWith("/").refine((p) => p !== "/", { message: "path must not be the filesystem root '/'" });

export const Role = z.enum(["harness", "plugin", "admin"]);
export type Role = z.infer<typeof Role>;

export const ApprovalPolicy = z.enum(["ask", "auto", "plan"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const HelloParams = z.object({
  protocolVersion: z.number().int(),
  role: Role,
  token: z.string().min(1),
  clientName: z.string().min(1),
  // Phase 4b Task 2 (spec §3): role "plugin" is id-bound (a plugin authenticates AS a specific
  // installed plugin id, not just "any plugin"). Verification is sqlite-hashed and lives outside
  // TokenAuthority — ipc/server.ts routes role "plugin" through SessionStore.verifyPluginToken
  // instead; a missing pluginId (or one with no minted/matching token) fails closed.
  pluginId: z.string().min(1).optional(),
});
export const HelloResult = z.object({
  ok: z.literal(true),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
});

export const SessionCreateParams = z.object({
  scope: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/), // slug: no leading/trailing hyphen, ≤41 chars
  cwd: AbsoluteDirPath.optional(),        // absolute path (not '/'); session working directory for tools
  approvalPolicy: ApprovalPolicy.default("ask"),
});
export const SessionCreateResult = z.object({ sessionId: z.string(), trusted: z.boolean() });

export const SessionListResult = z.object({
  sessions: z.array(z.object({
    sessionId: z.string(),
    scope: z.string(),
    createdAt: z.number().int(),
    lastSeq: z.number().int().nonnegative(),
  })),
});

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  fromSeq: z.number().int().nonnegative().optional().default(0),
});
export const SessionAttachResult = z.object({ ok: z.literal(true), lastSeq: z.number().int().nonnegative() });

export const SessionSendParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
});
export const SessionSendResult = z.object({ seq: z.number().int() });

export const ApprovalRespondParams = z.object({
  sessionId: z.string(),
  callId: z.string().min(1),
  approved: z.boolean(),
});
export const ApprovalRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const SessionAddDirParams = z.object({
  sessionId: z.string(),
  path: z.string().min(1),
  persist: z.boolean().default(false),
});
export const SessionAddDirResult = z.object({ ok: z.literal(true), roots: z.array(z.string()) });
export const SessionSetCwdParams = z.object({ sessionId: z.string(), cwd: AbsoluteDirPath });
export const SessionSetCwdResult = z.object({ ok: z.literal(true), cwd: z.string() });

export const TrustDirParams = z.object({ path: AbsoluteDirPath });
export const TrustDirResult = z.object({ ok: z.literal(true), trusted: z.literal(true) });

/** Server → client notification: method "event", params = SessionEvent. */
export const EventNotificationParams = SessionEvent;

export const BgTaskSummary = z.object({ taskId: z.string(), command: z.string(), status: z.string(), exitCode: z.number().int().nullable(), startedAt: z.number() });
export const BgListParams = z.object({ sessionId: z.string() });
export const BgListResult = z.object({ tasks: z.array(BgTaskSummary) });
export const BgPeekParams = z.object({ sessionId: z.string(), taskId: z.string().min(1) });
export const BgPeekResult = z.object({ chunk: z.string(), status: z.string(), exitCode: z.number().int().nullable() });
export const BgKillParams = z.object({ sessionId: z.string(), taskId: z.string().min(1) });
export const BgKillResult = z.object({ ok: z.literal(true) });
export const BgKillAllParams = z.object({ sessionId: z.string() });
export const BgKillAllResult = z.object({ ok: z.literal(true), killed: z.number().int().nonnegative() });

export const SessionSteerParams = z.object({ sessionId: z.string(), text: z.string().min(1) });
export const SessionSteerResult = z.object({ ok: z.literal(true), injected: z.boolean() });
export const SessionInterruptParams = z.object({ sessionId: z.string() });
export const SessionInterruptResult = z.object({ ok: z.literal(true), wasRunning: z.boolean() });

export const SessionCompactParams = z.object({ sessionId: z.string().min(1) });
export const SessionCompactResult = z.object({
  ok: z.literal(true),
  compacted: z.boolean(),
  uptoSeq: z.number().int().nonnegative(),
  summaryChars: z.number().int().nonnegative(),
});

export const SkillMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["project", "user", "self", "plugin"]),
  path: z.string(),
});
export const SkillsListParams = z.object({ cwd: z.string().optional() });
export const SkillsListResult = z.object({ ok: z.literal(true), skills: z.array(SkillMetaSchema) });

export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.enum(["connected", "failed"]),
  toolNames: z.array(z.string()),
  source: z.enum(["user", "project", "plugin"]),
});
export const McpListParams = z.object({ cwd: z.string().optional() });
export const McpListResult = z.object({ ok: z.literal(true), servers: z.array(McpServerStatusSchema) });

export const PluginInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  skills: z.array(z.string()),
  hasMcp: z.boolean(),
  mcpEnabled: z.boolean(),
  disabled: z.boolean(),
  // Phase 4a Task 3 additions — carried so the CLI's consent flow (norma plugin enable/list) can
  // render tier + consent state + the full exec-payload disclosure without a second round trip.
  // All optional so older-shaped fixtures/servers still parse (see methods.test.ts).
  tier: z.enum(["capability", "platform"]).optional(),
  requiredConsents: z.array(z.string()).optional(),
  consented: z.array(z.string()).optional(),
  legacy: z.boolean().optional(),
  /** Verbatim exec-payload disclosure lines (plugin-manifest.ts#execPayloadLines) — spec §1:
   *  "Consent text always shows the exec payload ... never just a summary." */
  execPayload: z.array(z.string()).optional(),
  /** manifest.permissions.tcc verbatim, for the "will request macOS permission: <each>" lines. */
  tccPermissions: z.array(z.string()).optional(),
  /** manifest.permissions.hardware verbatim, for the "hardware access via Norma.app helper: <each>" lines. */
  hardwarePermissions: z.array(z.string()).optional(),
});
export const PluginsListParams = z.object({});
export const PluginsListResult = z.object({ ok: z.literal(true), plugins: z.array(PluginInfoSchema) });

export const AskUserRespondParams = z.object({
  sessionId: z.string().min(1), callId: z.string().min(1), answers: z.record(z.string(), z.string()),
});
export const AskUserRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const TaskListParams = z.object({ sessionId: z.string().min(1) });
export const TaskListResult = z.object({ ok: z.literal(true), tasks: z.array(TaskSchema) });

export const PlanRespondParams = z.object({
  sessionId: z.string().min(1), callId: z.string().min(1), approved: z.boolean(),
  feedback: z.string().optional(), autoAccept: z.boolean().default(false),
});
export const PlanRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const SessionSetPolicyParams = z.object({ sessionId: z.string().min(1), policy: ApprovalPolicy });
export const SessionSetPolicyResult = z.object({ ok: z.literal(true) });

export const ThreadInfoSchema = z.object({
  threadId: z.string(), parentThreadId: z.string().optional(), agentType: z.string().optional(),
  status: z.enum(["running", "completed"]), stopReason: z.string().optional(),
});
export const ThreadListParams = z.object({ sessionId: z.string().min(1) });
export const ThreadListResult = z.object({ ok: z.literal(true), threads: z.array(ThreadInfoSchema) });

// ---------------------------------------------------------------------------------------------
// Peripheral lease v1 (Phase 2f, spec §A2) + dashboard read methods (spec Part B).
// ---------------------------------------------------------------------------------------------

/** The 5-member reason union shared with `LeaseLostEvent` (events.ts) — kept as a separate
 *  literal here (rather than importing the event schema's inner shape) since zod object shapes
 *  don't expose their field schemas for reuse without reaching into `.shape`. */
const LeaseLostReasonSchema = z.enum(["expired", "released", "panic", "revoked", "provider-gone"]);

/** A `denied` result additionally carries an optional `reason` — used for the pinned
 *  `{code:"denied", reason:"plugin-leasing-not-yet-available"}` typed error (spec §A2 requester
 *  scope: sessions-only in v1) as well as the plain policy-denied case (`reason` omitted). */
const PeripheralDeniedSchema = z.object({ code: z.literal("denied"), reason: z.string().optional() });

export const PeripheralLeaseParams = z.object({ sessionId: z.string().min(1), class: PeripheralClassSchema });
export const PeripheralLeaseResult = z.union([
  z.object({ leaseId: z.string().min(1), token: z.string().min(1), expiresAt: z.number().int().nonnegative() }),
  z.object({ code: z.literal("lease_held"), holder: HolderSchema }),
  z.object({ code: z.literal("no_provider") }),
  PeripheralDeniedSchema,
]);

export const PeripheralRenewParams = z.object({ sessionId: z.string().min(1), leaseId: z.string().min(1), token: z.string().min(1) });
export const PeripheralRenewResult = z.union([
  z.object({ ok: z.literal(true), expiresAt: z.number().int().nonnegative() }),
  z.object({ code: z.literal("not_found") }),
  z.object({ code: z.literal("token_mismatch") }),
  // L1 fix: renew() now rejects a lease past its expiresAt but not yet swept, instead of
  // silently resurrecting it — see PeripheralBroker.renew()'s RenewError union in broker.ts.
  z.object({ code: z.literal("expired") }),
  PeripheralDeniedSchema,
]);

export const PeripheralReleaseParams = z.object({ sessionId: z.string().min(1), leaseId: z.string().min(1), token: z.string().min(1) });
export const PeripheralReleaseResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ code: z.literal("not_found") }),
  z.object({ code: z.literal("token_mismatch") }),
  PeripheralDeniedSchema,
]);

export const PeripheralAdvertiseParams = z.object({
  classes: z.array(z.object({ class: PeripheralClassSchema, tccGranted: z.boolean() })),
});
export const PeripheralAdvertiseResult = z.object({ ok: z.literal(true) });

export const PeripheralRevokeParams = z.object({
  leaseId: z.string().min(1).optional(),
  all: z.boolean().optional(),
  reason: LeaseLostReasonSchema,
});
export const PeripheralRevokeResult = z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() });

export const PeripheralRespondParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const PeripheralRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const DaemonStatusParams = z.object({});
export const DaemonStatusResult = z.object({
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  socketPath: z.string(),
  provider: z.object({ id: z.string(), model: z.string() }).nullable(),
  sessionsCount: z.number().int().nonnegative(),
  pluginsCount: z.number().int().nonnegative(),
});

export const QuotaStateParams = z.object({});
/** The FLAT merge of `QuotaManager.state()` ({kind:"ok"} | {kind:"limited", resumeAt}) and
 *  `.usage()` ({inputTokens, outputTokens}) — matches NormaKit's `quotaState()` wrapper
 *  field-for-field (apple/NormaKit/Sources/NormaKit/NormaClient+Methods.swift). */
export const QuotaStateResult = z.object({
  kind: z.enum(["ok", "limited"]),
  resumeAt: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const TrustListParams = z.object({});
export const TrustListResult = z.object({ dirs: z.array(z.string()) });

export const TrustRemoveParams = z.object({ path: AbsoluteDirPath });
export const TrustRemoveResult = z.object({ removed: z.boolean() });

// ---------------------------------------------------------------------------------------------
// Plugin role verbs (Phase 4b Task 1, spec §3 "Tier-2 — supervisor + plugin role"). Wire shapes
// only here — the supervisor/registry wiring that makes these verbs DO something (ToolRegistry
// registration, contrib registries) is Task 3/4. Task 2 implements the role→methods allowlist
// (ipc/server.ts) covering EXACTLY these six verbs — a plugin connection may call these and
// nothing else; everything else, including the 2f peripheral.lease/renew/release verbs the spec
// text names as a plugin-facing cross-spec fix, is role-rejected. That's a deliberate narrowing
// of the spec's plugin-can-lease language for this task's scope (Task 2's contract fixes exactly
// these six) — widening the allowlist to admit peripheral leasing for plugins, if still wanted,
// is a follow-up decision for a later task, not implied by anything below.
// ---------------------------------------------------------------------------------------------

export const PluginRegisterParams = z.object({ pluginId: z.string().min(1) });
export const PluginRegisterResult = z.object({ ok: z.literal(true) });

/** Safe tool-name charset (final-review Fix 3): the wire `name` becomes the last segment of the
 *  namespaced tool `plugin__<pluginId>__<name>` (ipc/server.ts's `tool.register` handler), and
 *  `ToolRegistry.unregisterByPrefix("plugin__<id>__")` (agent/tools/registry.ts) matches by plain
 *  STRING PREFIX on that namespaced name. A `__` inside a tool name (or a pluginId — warned about
 *  separately at plugin load time, agent/plugin-manifest.ts#loadManifest) can make one plugin's
 *  registeredAs collide with a DIFFERENT plugin's unregister prefix, so a sibling plugin loses
 *  tools it never registered when the wrong plugin disconnects or its circuit trips. Alphanumeric
 *  plus single `-`/`_` separators only — no leading/trailing/double underscore, no other
 *  punctuation. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** `parameters` is a raw JSON-schema-shaped record (mirrors ToolDef.rawParameters in
 *  agent/tools/registry.ts) — the plugin author supplies whatever `z.toJSONSchema` would've
 *  produced; core does not re-validate its shape beyond "is an object". Optional: a schema-less
 *  tool is still registrable (deferred-detail case — spec §3 "optionally deferred JSON schema"). */
export const ToolRegisterParams = z.object({
  name: z.string().min(1).regex(SAFE_TOOL_NAME, {
    message: "tool name must be alphanumeric with single - or _ separators (no leading/trailing/double underscore)",
  }),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
/** `registeredAs` is the namespaced tool name core assigns (`plugin__<pluginId>__<name>`, Task 4)
 *  — round-tripped to the plugin so its own logs/errors can reference the name the agent sees. */
export const ToolRegisterResult = z.object({ ok: z.literal(true), registeredAs: z.string().min(1) });

export const ShortcutRegisterParams = z.object({
  shortcuts: z.array(z.object({
    id: z.string().min(1),
    description: z.string().optional(),
    default: z.string().optional(), // default keybinding suggestion; user-set binding always wins (spec §6)
  })),
});
export const ShortcutRegisterResult = z.object({ ok: z.literal(true) });

/** Declarative tile schema is spec §6's `{title, value?, icon?, progress?, actions?}` — kept as an
 *  opaque record at the wire layer (like ToolRegisterParams.parameters) since core's job is
 *  latest-per-plugin storage + broadcast, not shape validation of plugin-supplied UI data. */
export const TileUpdateParams = z.object({ tile: z.record(z.string(), z.unknown()) });
export const TileUpdateResult = z.object({ ok: z.literal(true) });

/** Reserved-minimal (spec §3 `provider?: true` manifest flag): model-provider registration wiring
 *  is a later plugin's phase (the local-models plugin), not Phase 4b. `info` is opaque here. */
export const ProviderRegisterParams = z.object({ info: z.record(z.string(), z.unknown()) });
export const ProviderRegisterResult = z.object({ ok: z.literal(true) });

/** A plugin's answer to a `plugin_tool_invoke` push (events.ts) — the PluginSupervisor's
 *  request/response correlation (Task 3), mirroring `PeripheralRespondParams`'s shape exactly
 *  (`peripheral.respond`'s provider-answers-a-push pattern) but without `alreadyResolved`: the
 *  supervisor's pending-invoke map is the single source of truth for double-settle guarding, not
 *  the wire result. */
export const PluginToolResultParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const PluginToolResultResult = z.object({ ok: z.literal(true) });

/** Harness-role admin verb (Phase 4b Task 2, spec §3): deletes a plugin's stored token hash so a
 *  subsequent plugin hello for that id fails closed. Mirrors trust.remove's role precedent — NOT
 *  itself one of the six plugin-role verbs (a plugin can never revoke its own or another plugin's
 *  token). Exists because `plugin_tokens` lives in the daemon's sqlite: the CLI's disable/remove
 *  never opens that database directly (locking risk) and calls this RPC best-effort instead —
 *  mint stays daemon-side (Task 3, at supervisor spawn). */
export const PluginRevokeTokenParams = z.object({ pluginId: z.string().min(1) });
export const PluginRevokeTokenResult = z.object({ ok: z.literal(true) });

/** Final-review Fix 1: the manual-restart rider (`PluginSupervisor.restart`, plugins/supervisor.ts
 *  — existed and was tested but had no caller) exposed over the wire so `norma plugin restart
 *  <id>` can recover a plugin stuck "circuit-open" (nothing else ever clears that state short of
 *  a daemon restart). Same role precedent as `plugins.list` — harness OR admin, NOT one of the six
 *  plugin-role verbs (a plugin can never restart itself or another plugin). */
export const PluginRestartParams = z.object({ pluginId: z.string().min(1) });
export const PluginRestartResult = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Hardware helper (Phase 4c Task 1, spec §5): plugin (or harness, dev/testing) → core →
// Norma.app's XPC helper. `hardware.request` is PLUGIN-CALLABLE (ipc/server.ts's
// PLUGIN_ALLOWED_METHODS gains it, growing the plugin-role allowlist to seven verbs);
// `hardware.respond` is NOT — only the active provider connection (Norma.app) may answer a
// `hardware_requested` push (events.ts), same precedent as `peripheral.respond` above. The
// core-side broker (Task 2) owns unknown-verb/consent/no-provider/timeout error shaping; this
// task only pins the wire shapes.
// ---------------------------------------------------------------------------------------------

export const HardwareRequestParams = z.object({
  verb: z.string().min(1),
  argsJson: z.string().optional(),
});
/** Task 2 review pin (binding): a typed RESULT UNION, not RpcFailure — mirrors
 *  `PeripheralLeaseResult`'s success|error-code union shape (see "Peripheral lease v1" above).
 *  Success carries `resultJson`; failures are typed by `code`: `unknown_verb`
 *  (`verbClass(verb) === null`, core's peripheral/hardware.ts), `consent_denied` (a plugin-role
 *  caller's manifest permissions/consent record didn't cover the verb's class — `missing` names
 *  which permission/consent class was absent), `no_provider` (Norma.app isn't connected —
 *  `message` is the user-facing "hardware features require Norma.app" string), `timeout` (the
 *  provider never answered within the broker's timeoutMs), and `provider_error` (the provider's
 *  own `hardware.respond` carried an `error` string, passed through verbatim as `message`). */
export const HardwareRequestResult = z.union([
  z.object({ resultJson: z.string() }),
  z.object({ code: z.literal("unknown_verb") }),
  z.object({ code: z.literal("consent_denied"), missing: z.string().optional() }),
  z.object({ code: z.literal("no_provider"), message: z.string() }),
  z.object({ code: z.literal("timeout") }),
  z.object({ code: z.literal("provider_error"), message: z.string() }),
]);

/** The active provider connection's answer to a `hardware_requested` push — mirrors
 *  `PeripheralRespondParams`'s shape exactly (provider-answers-a-push pattern) but without
 *  `alreadyResolved`, same precedent as `PluginToolResultParams`: the broker's pending-request
 *  map (Task 2) is the single source of truth for double-settle guarding, not the wire result. */
export const HardwareRespondParams = z.object({
  requestId: z.string().min(1),
  resultJson: z.string().optional(),
  error: z.string().optional(),
});
export const HardwareRespondResult = z.object({ ok: z.literal(true) });

export const METHODS = {
  hello: "protocol.hello",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionAttach: "session.attach",
  sessionSend: "session.send",
  approvalRespond: "approval.respond",
  sessionAddDir: "session.addDir",
  sessionSetCwd: "session.setCwd",
  trustDir: "daemon.trustDir",
  event: "event",
  bgList: "bg.list",
  bgPeek: "bg.peek",
  bgKill: "bg.kill",
  bgKillAll: "bg.killAll",
  sessionSteer: "session.steer",
  sessionInterrupt: "session.interrupt",
  sessionCompact: "session.compact",
  skillsList: "skills.list",
  mcpList: "mcp.list",
  pluginsList: "plugins.list",
  askUserRespond: "ask_user.respond",
  taskList: "task.list",
  planRespond: "plan.respond",
  sessionSetPolicy: "session.setPolicy",
  threadList: "thread.list",
  peripheralLease: "peripheral.lease",
  peripheralRenew: "peripheral.renew",
  peripheralRelease: "peripheral.release",
  peripheralAdvertise: "peripheral.advertise",
  peripheralRevoke: "peripheral.revoke",
  peripheralRespond: "peripheral.respond",
  daemonStatus: "daemon.status",
  quotaState: "quota.state",
  trustList: "trust.list",
  trustRemove: "trust.remove",
  pluginRegister: "plugin.register",
  toolRegister: "tool.register",
  shortcutRegister: "shortcut.register",
  tileUpdate: "tile.update",
  providerRegister: "provider.register",
  pluginToolResult: "plugin.toolResult",
  pluginRevokeToken: "plugin.revokeToken",
  pluginRestart: "plugin.restart",
  hardwareRequest: "hardware.request",
  hardwareRespond: "hardware.respond",
} as const;
