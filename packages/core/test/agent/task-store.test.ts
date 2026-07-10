import { describe, expect, test } from "bun:test";
import { TaskStore } from "../../src/agent/task-store";

describe("TaskStore", () => {
  test("create → pending, sequential ids per session, insertion order", () => {
    const store = new TaskStore();
    const t1 = store.create("s1", "Task 1", "desc 1");
    const t2 = store.create("s1", "Task 2", "desc 2");
    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t2.status).toBe("pending");
    const list = store.list("s1");
    expect(list).toHaveLength(2);
    expect(list[0]!).toMatchObject({ id: "1", subject: "Task 1", status: "pending" });
    expect(list[1]!).toMatchObject({ id: "2", subject: "Task 2", status: "pending" });
  });

  test("update patches fields; unknown id → undefined", () => {
    const store = new TaskStore();
    const t1 = store.create("s1", "Task 1", "desc 1");
    const updated = store.update("s1", t1.id, { status: "in_progress" });
    expect(updated).toMatchObject({ id: "1", subject: "Task 1", status: "in_progress" });
    const notFound = store.update("s1", "999", { status: "completed" });
    expect(notFound).toBeUndefined();
  });

  test("sessions isolated (ids restart at 1; lists independent)", () => {
    const store = new TaskStore();
    const t1s1 = store.create("s1", "S1 Task 1", "desc s1");
    const t1s2 = store.create("s2", "S2 Task 1", "desc s2");
    expect(t1s1.id).toBe("1");
    expect(t1s2.id).toBe("1");
    expect(store.list("s1")).toHaveLength(1);
    expect(store.list("s2")).toHaveLength(1);
    expect(store.list("s1")[0]!.subject).toBe("S1 Task 1");
    expect(store.list("s2")[0]!.subject).toBe("S2 Task 1");
  });

  // 4g-ii (CC parity): description is core-side only (protocol's Task has no such field — zero
  // protocol drift) — stored/retrievable via descriptionOf(), but NEVER surfaced through
  // list()/create()'s return value, matching the wire Task shape byte-for-byte.
  test("description is stored core-side (descriptionOf) but never appears on the Task objects from create()/list()", () => {
    const store = new TaskStore();
    const t1 = store.create("s1", "Task 1", "the actual description");
    expect(store.descriptionOf("s1", t1.id)).toBe("the actual description");
    expect(t1).not.toHaveProperty("description");
    expect(store.list("s1")[0]).not.toHaveProperty("description");
  });

  // delete(): terminal removal (no "deleted" status on the wire Task type — see task-store.ts's
  // doc comment). Removes both the task and its stored description.
  test("delete() removes the task from list() and its stored description; returns false for an unknown id", () => {
    const store = new TaskStore();
    const t1 = store.create("s1", "Task 1", "desc 1");
    expect(store.delete("s1", t1.id)).toBe(true);
    expect(store.list("s1")).toHaveLength(0);
    expect(store.descriptionOf("s1", t1.id)).toBeUndefined();
    expect(store.delete("s1", "999")).toBe(false);
  });
});
