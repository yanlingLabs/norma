import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { TaskStore } from "../../src/agent/task-store";
import { registerTaskTools } from "../../src/agent/tools/tasks";
import type { Task } from "@norma/protocol";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

function buildRegistry(store: TaskStore): ToolRegistry {
  const r = new ToolRegistry();
  registerTaskTools(r, { tasks: store });
  return r;
}

describe("task tools", () => {
  test("task_create emits task_updated and reports the id", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    const out = await r.execute("task_create", { subject: "rename", activeForm: "Renaming" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Task #1 created");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "1", status: "pending", subject: "rename", activeForm: "Renaming" });
  });

  test("task_update status flows + emits; unknown id isError", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    const created = await r.execute("task_create", { subject: "work" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(created.isError).toBe(false);
    const updated1 = await r.execute("task_update", { taskId: "1", status: "in_progress" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(updated1.isError).toBe(false);
    expect(updated1.output).toContain("◐");
    const updated2 = await r.execute("task_update", { taskId: "1", status: "completed" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(updated2.isError).toBe(false);
    expect(updated2.output).toContain("☑");
    expect(events).toHaveLength(3);
    expect(events[0]!.status).toBe("pending");
    expect(events[1]!.status).toBe("in_progress");
    expect(events[2]!.status).toBe("completed");
    const notFound = await r.execute("task_update", { taskId: "nope", status: "completed" }, ctx());
    expect(notFound.isError).toBe(true);
    expect(notFound.output).toContain("no such task");
  });

  test("task_update with no fields → invalid arguments", async () => {
    const store = new TaskStore();
    const r = buildRegistry(store);
    const out = await r.execute("task_update", { taskId: "1" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments");
  });

  test("task_list renders icons ☐/◐/☑ and 'no tasks'", async () => {
    const store = new TaskStore();
    const r = buildRegistry(store);
    const empty = await r.execute("task_list", {}, ctx());
    expect(empty.isError).toBe(false);
    expect(empty.output).toBe("no tasks");
    await r.execute("task_create", { subject: "pending task" }, ctx());
    await r.execute("task_create", { subject: "in-progress task" }, ctx());
    await r.execute("task_update", { taskId: "2", status: "in_progress" }, ctx());
    const listed = await r.execute("task_list", {}, ctx());
    expect(listed.isError).toBe(false);
    expect(listed.output).toContain("[1] ☐ pending task");
    expect(listed.output).toContain("[2] ◐ in-progress task");
  });
});
