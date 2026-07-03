import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { TaskStore } from "../task-store";

const ICONS = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

const TaskCreateArgsSchema = z.object({ subject: z.string().min(1), activeForm: z.string().optional() });
const TaskUpdateArgsSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  subject: z.string().min(1).optional(),
  activeForm: z.string().optional(),
}).refine((a) => a.status !== undefined || a.subject !== undefined || a.activeForm !== undefined, { message: "provide at least one of status/subject/activeForm" });
const TaskListArgsSchema = z.object({});

export function registerTaskTools(r: ToolRegistry, deps: { tasks: TaskStore }): void {
  r.register({
    name: "task_create",
    description: "Create a task on this session's task list (status starts as pending). Use task_update to mark it in_progress/completed as you work. The list is shown live to the user.",
    args: TaskCreateArgsSchema,
    run({ subject, activeForm }: z.infer<typeof TaskCreateArgsSchema>, ctx) {
      const t = deps.tasks.create(ctx.sessionId, subject, activeForm);
      ctx.taskEvent?.(t);
      return `Task #${t.id} created: ${t.subject}`;
    },
  });
  r.register({
    name: "task_update",
    description: "Update a task's status (pending | in_progress | completed), subject, or activeForm.",
    args: TaskUpdateArgsSchema,
    run({ taskId, status, subject, activeForm }: z.infer<typeof TaskUpdateArgsSchema>, ctx) {
      const patch: { status?: typeof status; subject?: typeof subject; activeForm?: typeof activeForm } = {};
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
