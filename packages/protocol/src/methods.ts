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
} as const;
