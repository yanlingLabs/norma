import { z } from "zod";

const Base = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(), // epoch ms
});

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
export const AgentErrorEvent = ThreadBase.extend({ type: z.literal("agent_error"), message: z.string() });
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

export const QuestionOptionSchema = z.object({ label: z.string().min(1), description: z.string().optional() });
export const QuestionSchema = z.object({
  question: z.string().min(1), header: z.string().min(1).max(12),
  options: z.array(QuestionOptionSchema).min(2).max(4), multiSelect: z.boolean(),
});
export const TaskSchema = z.object({
  id: z.string().min(1), subject: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]), activeForm: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Task = z.infer<typeof TaskSchema>;

export const QuestionAskedEvent = ThreadBase.extend({
  type: z.literal("question_asked"), callId: z.string().min(1), questions: z.array(QuestionSchema).min(1).max(4),
});
export const QuestionResolvedEvent = ThreadBase.extend({
  type: z.literal("question_resolved"), callId: z.string().min(1), answers: z.record(z.string(), z.string()), by: z.string().min(1),
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

export const SessionTitledEvent = ThreadBase.extend({
  type: z.literal("session_titled"), title: z.string().min(1),
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
  SessionTitledEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Event payload before the store assigns seq/ts (distributes Omit over the union). */
type DistributedOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewSessionEvent = DistributedOmit<SessionEvent, "seq" | "ts">;
