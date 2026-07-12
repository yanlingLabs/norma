import { z } from "zod";

const Base = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(), // epoch ms
});

/** Sentinel `sessionId` for events that aren't scoped to any session (Phase 4d Task 1's
 *  `plugin_tile_updated`, spec §6/§7): a dashboard connection is never "attached" to a session
 *  (there's nothing to `session.attach` to for a plugin tile), so these events are broadcast
 *  server-side by looping every authed harness connection (ipc/server.ts's `harnessConns`, the
 *  same mechanism `session_created` already uses) rather than through the per-session
 *  `SessionHub`. `Base.sessionId` requires `min(1)`, so a session-less event still needs SOME
 *  non-empty string to satisfy the schema — `$system` is reserved for exactly that (never a real
 *  session id: `SessionStore.createSession` always mints `s_<12-hex-chars>`, so a literal `$`
 *  prefix can never collide with a real session's id). */
export const SYSTEM_SESSION_ID = "$system";

export const SessionCreatedEvent = Base.extend({
  type: z.literal("session_created"),
  scope: z.string().min(1),
});

export const HarnessAttachedEvent = Base.extend({
  type: z.literal("harness_attached"),
  clientName: z.string().min(1),
});

export const HarnessDetachedEvent = Base.extend({
  type: z.literal("harness_detached"),
  clientName: z.string().min(1),
});

export const UserMessageEvent = Base.extend({
  type: z.literal("user_message"),
  threadId: z.string().min(1),
  text: z.string().min(1),
  clientName: z.string().min(1),
});

const ThreadBase = Base.extend({ threadId: z.string().min(1) });

export const TurnStartedEvent = ThreadBase.extend({ type: z.literal("turn_started") });
export const AssistantMessageEvent = ThreadBase.extend({ type: z.literal("assistant_message"), text: z.string() });
/** TRANSIENT streaming chunk: broadcast-only, never persisted to the session log and never
 *  replayed on attach. Carries seq = the store's lastSeq at broadcast time (NOT its own seq) —
 *  monotonic-safe for naive lastSeq tracking, but clients MUST exempt assistant_delta from
 *  seq-based dedupe and lastSeq updates. The final assistant_message is the persisted record. */
export const AssistantDeltaEvent = ThreadBase.extend({ type: z.literal("assistant_delta"), delta: z.string().min(1) });
export const ToolCallEvent = ThreadBase.extend({
  type: z.literal("tool_call"), callId: z.string().min(1), name: z.string().min(1), argsJson: z.string(),
});
export const ToolResultEvent = ThreadBase.extend({
  type: z.literal("tool_result"), callId: z.string().min(1), output: z.string(), isError: z.boolean(),
});
/** Opaque provider reasoning item (Responses API), captured at output_item.done and replayed
 *  verbatim into later requests (CC/Codex parity — see the history-parity spec). itemJson is
 *  SENSITIVE opaque state (encrypted_content): the session JSONL is its only sink; clients
 *  (CLI/app) deliberately do NOT model this variant — both skip unknown event types, so it
 *  never renders. Do NOT add a generator fixture: Swift's all-fixtures round-trip would degrade
 *  it to unknownEvent and fail equality; TS tests cover the variant. */
export const ReasoningItemEvent = ThreadBase.extend({ type: z.literal("reasoning_item"), itemJson: z.string().min(1) });
export const ApprovalRequestedEvent = ThreadBase.extend({
  type: z.literal("approval_requested"), callId: z.string().min(1), toolName: z.string().min(1), summary: z.string(),
});
export const ApprovalResolvedEvent = ThreadBase.extend({
  type: z.literal("approval_resolved"), callId: z.string().min(1), approved: z.boolean(), by: z.string().min(1),
});
export const TurnCompletedEvent = ThreadBase.extend({
  type: z.literal("turn_completed"), stopReason: z.enum(["end_turn", "aborted", "error"]),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
});
/** `code` (phase 5 routines T3, blocking concern carried from T2's runner.ts report): additive
 *  optional field on this EXISTING variant (not a new SessionEvent variant — no NormaKit
 *  exhaustive-switch trap) mirroring `ProviderEvent`'s own `{type:"error", code, message,
 *  retryAfterMs?}` shape (providers/types.ts) — `engine.ts` forwards `ev.code` when the error came
 *  from a live provider stream; the two synthetic `agent_error` emit sites (no cwd, context-cap)
 *  have no provider code and simply omit it. Lets a consumer (routines/runner.ts's quota
 *  detection) check `code === "rate_limit"` instead of string-matching the message's `"HTTP 429"`
 *  prefix — see runner.ts's own doc comment for why that prefix match remains as a fallback for
 *  older logs / synthetic errors that never carried a code. */
export const AgentErrorEvent = ThreadBase.extend({ type: z.literal("agent_error"), message: z.string(), code: z.string().optional() });
export const DirectoryAddedEvent = ThreadBase.extend({
  type: z.literal("directory_added"),
  path: z.string().min(1),
  persisted: z.boolean(),
});

export const BgTaskStartedEvent = ThreadBase.extend({ type: z.literal("bg_task_started"), taskId: z.string().min(1), command: z.string() });
export const BgTaskOutputEvent = ThreadBase.extend({ type: z.literal("bg_task_output"), taskId: z.string().min(1), chunk: z.string() });
export const BgTaskExitedEvent = ThreadBase.extend({ type: z.literal("bg_task_exited"), taskId: z.string().min(1), exitCode: z.number().int().nullable(), killed: z.boolean() });

export const CheckpointEvent = ThreadBase.extend({
  type: z.literal("checkpoint"), summary: z.string(), uptoSeq: z.number().int().nonnegative(),
});

export const QuestionOptionSchema = z.object({
  label: z.string().min(1), description: z.string().optional(),
  // CC AskUserQuestion parity: a per-option preview (e.g. a diff/scheme snippet rendered
  // alongside the option) shown in the "visual scheme on the right" panel. Optional/additive —
  // older-shaped questions without a preview still parse.
  preview: z.string().optional(),
});
export const QuestionSchema = z.object({
  question: z.string().min(1), header: z.string().min(1).max(12),
  options: z.array(QuestionOptionSchema).min(2).max(4), multiSelect: z.boolean(),
});
export const TaskSchema = z.object({
  id: z.string().min(1), subject: z.string().min(1),
  // "deleted" (T3 review fix wave 1): task_update{status:"deleted"} emits a task_updated event
  // carrying this status BEFORE the task is removed from the session's TaskStore, so live task
  // views (CLI pinned block, app SessionModel) can react by REMOVING the task instead of
  // upserting a phantom entry that outlives the delete. Terminal — no event ever transitions a
  // task OUT of "deleted".
  status: z.enum(["pending", "in_progress", "completed", "deleted"]), activeForm: z.string().optional(),
  // Task-graph fields (4h-ii-d, CC parity) — all optional/additive so old-shaped tasks (none of
  // these) keep parsing identically. owner: an agent name/id or "user" that owns the task.
  // blocks/blockedBy: ids of tasks this task blocks / is blocked by — task_update's
  // addBlocks/addBlockedBy append+dedupe into these (tools/tasks.ts); referenced ids are NOT
  // validated to exist here or there, since the referenced task may be created later. metadata:
  // a free-form shallow-mergeable bag (task_update's metadata arg merges new keys in; no delete
  // mechanism — YAGNI).
  owner: z.string().min(1).optional(),
  blocks: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Task = z.infer<typeof TaskSchema>;

export const QuestionAskedEvent = ThreadBase.extend({
  type: z.literal("question_asked"), callId: z.string().min(1), questions: z.array(QuestionSchema).min(1).max(4),
});
export const QuestionResolvedEvent = ThreadBase.extend({
  type: z.literal("question_resolved"), callId: z.string().min(1), answers: z.record(z.string(), z.string()), by: z.string().min(1),
  // CC AskUserQuestion parity: free-text notes ("press n to add notes"), keyed by question text
  // like `answers`. Optional/additive — older-shaped resolutions without notes still parse.
  notes: z.record(z.string(), z.string()).optional(),
});
export const TaskUpdatedEvent = ThreadBase.extend({ type: z.literal("task_updated"), task: TaskSchema });

export const PlanPresentedEvent = ThreadBase.extend({
  type: z.literal("plan_presented"), callId: z.string().min(1), plan: z.string().min(1),
});
export const PlanResolvedEvent = ThreadBase.extend({
  type: z.literal("plan_resolved"), callId: z.string().min(1), approved: z.boolean(),
  feedback: z.string().optional(), autoAccept: z.boolean(), by: z.string().min(1),
});

export const WorktreeEnteredEvent = ThreadBase.extend({
  type: z.literal("worktree_entered"), name: z.string().min(1), path: z.string().min(1), branch: z.string().min(1),
});
export const WorktreeExitedEvent = ThreadBase.extend({
  type: z.literal("worktree_exited"), name: z.string().min(1), action: z.enum(["keep", "remove"]), removed: z.boolean(),
});

export const ThreadStartedEvent = ThreadBase.extend({
  type: z.literal("thread_started"), parentThreadId: z.string().min(1), agentType: z.string(), prompt: z.string(),
  description: z.string().optional(),
});
export const ThreadCompletedEvent = ThreadBase.extend({
  type: z.literal("thread_completed"), stopReason: z.enum(["end_turn", "aborted", "error"]),
});

/** Background-agent completion notice (CC parity: <task-notification>), persisted and replayed as a
 *  user-role message so the model learns a detached agent finished without a user keystroke.
 *  Clients render nothing for it (thread_completed carries the visible finish line). Do NOT add a
 *  generator fixture: Swift round-trips it as unknownEvent (reasoning_item precedent). */
export const TaskNotificationEvent = ThreadBase.extend({ type: z.literal("task_notification"), content: z.string().min(1) });

export const SessionTitledEvent = ThreadBase.extend({
  type: z.literal("session_titled"), title: z.string().min(1),
});

/** Capability classes for the peripheral lease v1 stub (Phase 2f): the three real capabilities
 *  (implemented at Phase 5g) plus `noop`, the v1 stub used to gate the lease machinery end-to-end. */
export const PeripheralClassSchema = z.enum(["screenshot", "ax-read", "input-drive", "noop"]);
export const HolderSchema = z.object({
  kind: z.enum(["session", "plugin"]),
  id: z.string().min(1),
});
export type Holder = z.infer<typeof HolderSchema>;

/** TRANSIENT (broadcast-only via `broadcastTransient`, like `assistant_delta`): leases are
 *  runtime state — replay must never resurrect one. The audit log is the durable record.
 *
 *  `tokenHash` (sha256 hex of the raw token) rides this event so the PROVIDER can validate
 *  token+class+expiry on every `peripheral_call_requested` (spec §A1: "no token, no service") —
 *  the raw token itself is NEVER broadcast; it goes solely to the requester in the
 *  `peripheral.lease` RESPONSE and back from the requester in capability calls. */
export const LeaseGrantedEvent = ThreadBase.extend({
  type: z.literal("lease_granted"),
  leaseId: z.string().min(1),
  class: PeripheralClassSchema,
  holder: HolderSchema,
  expiresAt: z.number().int().nonnegative(),
  tokenHash: z.string().min(1),
});
/** TRANSIENT — see LeaseGrantedEvent. */
export const LeaseLostEvent = ThreadBase.extend({
  type: z.literal("lease_lost"),
  leaseId: z.string().min(1),
  class: PeripheralClassSchema,
  holder: HolderSchema,
  reason: z.enum(["expired", "released", "panic", "revoked", "provider-gone"]),
});
/** TRANSIENT — core pushes this to the provider's connection (approval-broker request/response
 *  pattern); the provider answers via `peripheral.respond {requestId, resultJson?, error?}`. */
export const PeripheralCallRequestedEvent = ThreadBase.extend({
  type: z.literal("peripheral_call_requested"),
  requestId: z.string().min(1),
  leaseId: z.string().min(1),
  token: z.string().min(1),
  class: PeripheralClassSchema,
  payloadJson: z.string(),
});

/** TRANSIENT (broadcast-only, like `assistant_delta`/the lease events above) — core pushes this
 *  to a plugin's own connection (the same approval-broker request/response pattern as
 *  `peripheral_call_requested`); the plugin answers via `plugin.toolResult`
 *  {requestId, resultJson?, error?} (methods.ts). A tool-call turn is never resurrected by
 *  replay, so this must never be persisted or re-delivered on session.attach. */
export const PluginToolInvokeEvent = ThreadBase.extend({
  type: z.literal("plugin_tool_invoke"),
  requestId: z.string().min(1),
  tool: z.string().min(1),
  argsJson: z.string(),
});

/** TRANSIENT (broadcast-only, like `assistant_delta`/the lease events/`plugin_tool_invoke` above)
 *  — core pushes this to the active PROVIDER's connection (Norma.app, spec §5) when a plugin (or
 *  the harness, dev/testing) calls `hardware.request` (methods.ts): the app-side broker answers
 *  via `hardware.respond` {requestId, resultJson?, error?}, the same approval-broker
 *  request/response pattern as `peripheral_call_requested`/`plugin_tool_invoke`. A hardware verb
 *  call is never resurrected by replay, so this must never be persisted or re-delivered on
 *  session.attach. */
export const HardwareRequestedEvent = ThreadBase.extend({
  type: z.literal("hardware_requested"),
  requestId: z.string().min(1),
  verb: z.string().min(1),
  argsJson: z.string(),
});

/** TRANSIENT (broadcast-only, never appended to the session log/replayed on attach — there's no
 *  session to attach to; see `SYSTEM_SESSION_ID` above) — Phase 4d Task 1's live tile push. Core
 *  broadcasts this to every authed harness (ipc/server.ts's `broadcastTileUpdated`) whenever a
 *  plugin's `tile.update` lands in `PluginContribRegistry`, and again with `tile: null` when the
 *  plugin disconnects (its tile is cleared, and dashboards must drop the now-stale card). Extends
 *  `Base` directly (NOT `ThreadBase`) — a plugin's declarative tile isn't scoped to any thread. */
export const PluginTileUpdatedEvent = Base.extend({
  type: z.literal("plugin_tile_updated"),
  pluginId: z.string().min(1),
  tile: z.record(z.string(), z.unknown()).nullable(),
});

/** TRANSIENT (broadcast-only, never persisted to the session log/replayed on attach — there's no
 *  session to attach to; `sessionId` is always the `$system` sentinel) — Phase 4d Task 2's
 *  harness→plugin push: core sends this directly to a plugin's own connection when a future UI
 *  fires one of that plugin's registered shortcuts (`shortcut.invoke`, methods.ts). Extends `Base`
 *  directly (NOT `ThreadBase`), same reasoning as `PluginTileUpdatedEvent` above — this push isn't
 *  scoped to any thread. */
export const ShortcutInvokeEvent = Base.extend({
  type: z.literal("shortcut_invoke"),
  shortcutId: z.string().min(1),
});

/** TRANSIENT — see `ShortcutInvokeEvent` above. Phase 4d Task 2's other harness→plugin push: core
 *  sends this when a future UI clicks one of the plugin's declarative tile's action buttons
 *  (`tile.action`, methods.ts). */
export const TileActionEvent = Base.extend({
  type: z.literal("tile_action"),
  actionId: z.string().min(1),
});

export const SessionEvent = z.discriminatedUnion("type", [
  SessionCreatedEvent,
  HarnessAttachedEvent,
  HarnessDetachedEvent,
  UserMessageEvent,
  TurnStartedEvent,
  AssistantMessageEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  ReasoningItemEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  TurnCompletedEvent,
  AgentErrorEvent,
  DirectoryAddedEvent,
  BgTaskStartedEvent,
  BgTaskOutputEvent,
  BgTaskExitedEvent,
  CheckpointEvent,
  QuestionAskedEvent,
  QuestionResolvedEvent,
  TaskUpdatedEvent,
  PlanPresentedEvent,
  PlanResolvedEvent,
  WorktreeEnteredEvent,
  WorktreeExitedEvent,
  ThreadStartedEvent,
  ThreadCompletedEvent,
  TaskNotificationEvent,
  SessionTitledEvent,
  LeaseGrantedEvent,
  LeaseLostEvent,
  PeripheralCallRequestedEvent,
  PluginToolInvokeEvent,
  HardwareRequestedEvent,
  PluginTileUpdatedEvent,
  ShortcutInvokeEvent,
  TileActionEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Event payload before the store assigns seq/ts (distributes Omit over the union). */
type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributedOmit<SessionEvent, "seq" | "ts">;
