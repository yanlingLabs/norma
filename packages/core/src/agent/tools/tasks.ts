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
}).refine((a) => a.status !== undefined || a.subject !== undefined || a.activeForm !== undefined, { message: "provide at least one of status/subject/activeForm" });
const TaskListArgsSchema = z.object({});
const TaskGetArgsSchema = z.object({ taskId: z.string().min(1) });

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
    description: "Update a task's status (pending | in_progress | completed | deleted), subject, or activeForm. To complete or change an EXISTING task, pass its id from task_list — do NOT create a new task. Call task_list first if you don't know the id. Provide at least one of status/subject/activeForm besides taskId.",
    args: TaskUpdateArgsSchema,
    run({ taskId, status, subject, activeForm }: z.infer<typeof TaskUpdateArgsSchema>, ctx) {
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
      const patch: { status?: Task["status"]; subject?: typeof subject; activeForm?: typeof activeForm } = {};
      if (status !== undefined) patch.status = status;
      if (subject !== undefined) patch.subject = subject;
      if (activeForm !== undefined) patch.activeForm = activeForm;
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
      return lines.join("\n");
    },
  });
}
