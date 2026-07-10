import { z } from "zod";
import type { Task } from "@norma/protocol";
import type { ToolRegistry } from "./registry";
import type { TaskStore } from "../task-store";

const ICONS = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

const TaskCreateArgsSchema = z.object({ subject: z.string().min(1), description: z.string().min(1), activeForm: z.string().optional() });
const TaskUpdateArgsSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
  subject: z.string().min(1).optional(),
  activeForm: z.string().optional(),
}).refine((a) => a.status !== undefined || a.subject !== undefined || a.activeForm !== undefined, { message: "provide at least one of status/subject/activeForm" });
const TaskListArgsSchema = z.object({});

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
        const existed = deps.tasks.delete(ctx.sessionId, taskId);
        if (!existed) throw new Error(`no such task: ${taskId}`);
        // Terminal removal, not a status transition — @norma/protocol's Task.status enum has no
        // "deleted" value, so there is no task_updated event that could represent this without
        // either widening the protocol (out of scope, zero-drift constraint) or lying on the wire
        // with an existing status. The task simply stops appearing in task_list.
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
}
