import { z } from "zod";
import type { Task } from "@norma/protocol";
import type { ToolRegistry } from "./registry";
import type { TaskStore } from "../task-store";

const ICONS = { pending: "☐", in_progress: "◐", completed: "☑", deleted: "✗" } as const;

const TaskCreateArgsSchema = z.object({ subject: z.string().min(1), description: z.string().min(1), activeForm: z.string().optional() });
const TaskUpdateArgsSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
  subject: z.string().min(1).optional(),
  activeForm: z.string().optional(),
  // Task-graph fields (4h-ii-d, CC parity — mirrors @norma/protocol's TaskSchema widening).
  // addBlocks/addBlockedBy APPEND to the task's existing blocks/blockedBy lists (Set-union
  // dedupe, insertion order preserved); referenced ids are NOT validated to exist — a task may
  // legitimately reference one that gets created later. owner sets/replaces. metadata
  // SHALLOW-merges the given keys into existing metadata (new keys win; no delete mechanism —
  // YAGNI).
  addBlocks: z.array(z.string().min(1)).optional(),
  addBlockedBy: z.array(z.string().min(1)).optional(),
  owner: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (a) => a.status !== undefined || a.subject !== undefined || a.activeForm !== undefined
    || a.addBlocks !== undefined || a.addBlockedBy !== undefined || a.owner !== undefined || a.metadata !== undefined,
  { message: "provide at least one of status/subject/activeForm/addBlocks/addBlockedBy/owner/metadata" },
);
const TaskListArgsSchema = z.object({});
const TaskGetArgsSchema = z.object({ taskId: z.string().min(1) });

/** addBlocks/addBlockedBy append semantics (4h-ii-d, CC parity): Set union preserves insertion
 *  order — existing ids first, then newly-added ones, with duplicates (from either side) dropped.
 *  Referenced ids are NOT validated against the store — a task may reference one that is created
 *  later. */
function appendDeduped(existing: string[] | undefined, toAdd: string[]): string[] {
  return [...new Set([...(existing ?? []), ...toAdd])];
}

export function registerTaskTools(r: ToolRegistry, deps: { tasks: TaskStore }): void {
  r.register({
    name: "task_create",
    description: "Create a task on this session's task list (status starts pending). description: what needs to be done. Mark it in_progress via task_update BEFORE you begin working on it, completed when FULLY done — never mark completed while tests fail or work is partial. The list is shown live to the user. Call task_list first to avoid duplicates.",
    args: TaskCreateArgsSchema,
    run({ subject, description, activeForm }: z.infer<typeof TaskCreateArgsSchema>, ctx) {
      const t = deps.tasks.create(ctx.sessionId, subject, description, activeForm);
      ctx.taskEvent?.(t);
      return `Task #${t.id} created: ${t.subject}`;
    },
  });
  r.register({
    name: "task_update",
    description: "Update a task's status (pending | in_progress | completed | deleted), subject, activeForm, owner, or task-graph links. addBlocks/addBlockedBy APPEND ids to the task's existing blocks/blockedBy lists (deduped; referenced ids don't need to exist yet — they may be created later). owner sets/replaces who owns the task (an agent name/id or \"user\"). metadata SHALLOW-merges the given keys into existing metadata (new keys win; no delete). To complete or change an EXISTING task, pass its id from task_list — do NOT create a new task. Call task_list first if you don't know the id. Provide at least one of status/subject/activeForm/addBlocks/addBlockedBy/owner/metadata besides taskId.",
    args: TaskUpdateArgsSchema,
    run({ taskId, status, subject, activeForm, addBlocks, addBlockedBy, owner, metadata }: z.infer<typeof TaskUpdateArgsSchema>, ctx) {
      if (status === "deleted") {
        // T3 review fix wave 1: @norma/protocol's Task.status enum now HAS a "deleted" value
        // (events.ts's TaskSchema) — emit a task_updated event carrying it BEFORE the terminal
        // TaskStore.delete() removal, mirroring the update branch below (`build the task, emit,
        // then mutate`). Live task views (CLI pinned block, app SessionModel) key off this event
        // to REMOVE the task instead of upserting a phantom entry that outlives the delete.
        // `update()` both builds the full Task object (id/subject/status/activeForm) with the
        // new status AND doubles as the existence check — undefined means the id is unknown.
        const deleted = deps.tasks.update(ctx.sessionId, taskId, { status: "deleted" });
        if (!deleted) throw new Error(`no such task: ${taskId}`);
        ctx.taskEvent?.(deleted);
        deps.tasks.delete(ctx.sessionId, taskId);
        return `Task #${taskId} deleted`;
      }
      const patch: Partial<Omit<Task, "id">> = {};
      if (status !== undefined) patch.status = status;
      if (subject !== undefined) patch.subject = subject;
      if (activeForm !== undefined) patch.activeForm = activeForm;
      if (owner !== undefined) patch.owner = owner;
      // Task-graph fields (4h-ii-d): the append/dedupe and shallow-merge computation happens HERE
      // (not in the store) — read the current task, compute the new full arrays/object, and pass
      // them through as a plain "set" patch, mirroring how status/subject/activeForm already work.
      if (addBlocks !== undefined || addBlockedBy !== undefined || metadata !== undefined) {
        const existing = deps.tasks.get(ctx.sessionId, taskId);
        if (!existing) throw new Error(`no such task: ${taskId}`);
        if (addBlocks !== undefined) patch.blocks = appendDeduped(existing.blocks, addBlocks);
        if (addBlockedBy !== undefined) patch.blockedBy = appendDeduped(existing.blockedBy, addBlockedBy);
        if (metadata !== undefined) patch.metadata = { ...existing.metadata, ...metadata };
      }
      const t = deps.tasks.update(ctx.sessionId, taskId, patch);
      if (!t) throw new Error(`no such task: ${taskId}`);
      ctx.taskEvent?.(t);
      return `Task #${t.id} updated: ${ICONS[t.status]} ${t.subject}`;
    },
  });
  r.register({
    name: "task_list",
    description: "List this session's tasks with their statuses.",
    args: TaskListArgsSchema,
    run(_a: z.infer<typeof TaskListArgsSchema>, ctx) {
      const tasks = deps.tasks.list(ctx.sessionId);
      return tasks.length ? tasks.map((t) => `[${t.id}] ${ICONS[t.status]} ${t.subject}`).join("\n") : "no tasks";
    },
  });
  r.register({
    name: "task_get",
    description: "Get a task's full details (subject, description, status, activeForm) by id from task_list.",
    args: TaskGetArgsSchema,
    // New in 4g Task 4 (CC parity: task_create/task_update/task_list already existed — this
    // rounds out the CRUD set with a single-task read). Registered deferred: true on just this
    // def — the trio above stays always-loaded (unchanged pre-4g behavior); only this NEW tool
    // rides ToolSearch deferral.
    deferred: true,
    run({ taskId }: z.infer<typeof TaskGetArgsSchema>, ctx) {
      const t = deps.tasks.get(ctx.sessionId, taskId);
      if (!t) throw new Error(`no task ${taskId}`);
      const description = deps.tasks.descriptionOf(ctx.sessionId, taskId);
      const lines = [
        `#${t.id} ${ICONS[t.status]} ${t.subject}`,
        `status: ${t.status}`,
        `description: ${description ?? "(none)"}`,
      ];
      if (t.activeForm) lines.push(`activeForm: ${t.activeForm}`);
      // Task-graph fields (4h-ii-d, CC parity) — omit lines for absent fields.
      if (t.owner) lines.push(`owner: ${t.owner}`);
      if (t.blocks && t.blocks.length > 0) lines.push(`blocks: ${t.blocks.join(", ")}`);
      if (t.blockedBy && t.blockedBy.length > 0) lines.push(`blockedBy: ${t.blockedBy.join(", ")}`);
      if (t.metadata && Object.keys(t.metadata).length > 0) lines.push(`metadata: ${JSON.stringify(t.metadata)}`);
      return lines.join("\n");
    },
  });
}
