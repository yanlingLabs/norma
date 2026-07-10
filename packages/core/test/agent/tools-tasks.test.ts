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
    const out = await r.execute("task_create", { subject: "rename", description: "rename the thing", activeForm: "Renaming" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Task #1 created");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "1", status: "pending", subject: "rename", activeForm: "Renaming" });
  });

  test("task_create without description → invalid args", async () => {
    const store = new TaskStore();
    const r = buildRegistry(store);
    const out = await r.execute("task_create", { subject: "rename" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("description");
  });

  test("task_update status flows + emits; unknown id isError", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    const created = await r.execute("task_create", { subject: "work", description: "do the work" }, ctx({ taskEvent: (t) => events.push(t) }));
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
    await r.execute("task_create", { subject: "pending task", description: "do the pending thing" }, ctx());
    await r.execute("task_create", { subject: "in-progress task", description: "do the in-progress thing" }, ctx());
    await r.execute("task_update", { taskId: "2", status: "in_progress" }, ctx());
    const listed = await r.execute("task_list", {}, ctx());
    expect(listed.isError).toBe(false);
    expect(listed.output).toContain("[1] ☐ pending task");
    expect(listed.output).toContain("[2] ◐ in-progress task");
  });

  test("task_update status 'deleted' removes the task from task_list output; unknown id isError", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    await r.execute("task_create", { subject: "throwaway", description: "will be deleted" }, ctx({ taskEvent: (t) => events.push(t) }));
    const del = await r.execute("task_update", { taskId: "1", status: "deleted" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(del.isError).toBe(false);
    expect(del.output).toBe("Task #1 deleted");
    const listed = await r.execute("task_list", {}, ctx());
    expect(listed.output).toBe("no tasks");

    const notFound = await r.execute("task_update", { taskId: "999", status: "deleted" }, ctx());
    expect(notFound.isError).toBe(true);
    expect(notFound.output).toContain("no such task");
  });

  // T3 review fix wave 1: task_update{status:"deleted"} now emits ONE task_updated event carrying
  // the deleted task's full shape with status:"deleted" — BEFORE the store removal — so live task
  // views (CLI pinned block, app SessionModel) can react by removing the task instead of
  // phantoming it forever.
  test("task_update status 'deleted' emits a task_updated event with status 'deleted' before the store removal", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    await r.execute("task_create", { subject: "throwaway", description: "will be deleted", activeForm: "Deleting it" }, ctx({ taskEvent: (t) => events.push(t) }));
    const del = await r.execute("task_update", { taskId: "1", status: "deleted" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(del.isError).toBe(false);
    expect(events).toHaveLength(2); // task_create's event, then the deletion's
    expect(events[0]!.status).toBe("pending");
    expect(events[1]).toMatchObject({ id: "1", subject: "throwaway", status: "deleted", activeForm: "Deleting it" });
    // The store itself no longer has the task — the event fired for a task that is now gone.
    expect(store.list("s")).toHaveLength(0);
  });

  test("task_update status 'deleted' on an unknown id emits no event", async () => {
    const events: Task[] = [];
    const store = new TaskStore();
    const r = buildRegistry(store);
    const notFound = await r.execute("task_update", { taskId: "999", status: "deleted" }, ctx({ taskEvent: (t) => events.push(t) }));
    expect(notFound.isError).toBe(true);
    expect(events).toHaveLength(0);
  });

  test("task_create/task_update descriptions steer the model to list-before-create/update (misuse guard)", () => {
    const store = new TaskStore();
    const r = buildRegistry(store);
    const specs = r.specs();
    const create = specs.find((s) => s.name === "task_create");
    const update = specs.find((s) => s.name === "task_update");
    expect(create?.description).toContain("Call task_list first to avoid duplicates.");
    expect(update?.description).toContain("To complete or change an EXISTING task, pass its id from task_list — do NOT create a new task.");
    expect(update?.description).toContain("Call task_list first if you don't know the id.");
    expect(update?.description).toContain("deleted");
  });
});
