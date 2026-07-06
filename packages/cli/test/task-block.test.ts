import { describe, expect, test } from "bun:test";
import type { Task } from "@norma/protocol";
import { renderTaskBlock, TASK_ICONS, trackLineStart, upsertTask } from "../src/task-block";

function task(id: string, subject: string, status: Task["status"]): Task {
  return { id, subject, status };
}

describe("upsertTask", () => {
  test("appends a new task id, preserving arrival order", () => {
    const t1 = task("1", "write tests", "pending");
    const t2 = task("2", "ship it", "pending");
    expect(upsertTask([], t1)).toEqual([t1]);
    expect(upsertTask([t1], t2)).toEqual([t1, t2]);
  });

  test("replaces an existing id in place without reordering the list", () => {
    const t1 = task("1", "write tests", "pending");
    const t2 = task("2", "ship it", "pending");
    const t1Done: Task = { ...t1, status: "in_progress" };
    expect(upsertTask([t1, t2], t1Done)).toEqual([t1Done, t2]);
  });

  test("does not mutate the input array (pure)", () => {
    const t1 = task("1", "write tests", "pending");
    const original = [t1];
    upsertTask(original, task("2", "ship it", "pending"));
    expect(original).toEqual([t1]);
  });
});

describe("renderTaskBlock", () => {
  test("maps each status to its glyph and pairs it with the subject", () => {
    const tasks = [task("1", "write tests", "pending"), task("2", "run tests", "in_progress"), task("3", "commit", "completed")];
    expect(renderTaskBlock(tasks)).toEqual([
      `${TASK_ICONS.pending} write tests`,
      `${TASK_ICONS.in_progress} run tests`,
      `${TASK_ICONS.completed} commit`,
    ]);
  });

  test("empty task list renders nothing", () => {
    expect(renderTaskBlock([])).toEqual([]);
  });

  test("all-completed task list renders nothing (CC parity: block disappears)", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "completed")];
    expect(renderTaskBlock(tasks)).toEqual([]);
  });

  test("mix of completed and incomplete still renders the full list", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "pending")];
    expect(renderTaskBlock(tasks)).toEqual([`${TASK_ICONS.completed} write tests`, `${TASK_ICONS.pending} ship it`]);
  });
});

describe("trackLineStart (safe-repaint-point rule)", () => {
  test("a write ending in a newline puts us at a safe fresh-line boundary", () => {
    expect(trackLineStart(false, "hello\n")).toBe(true);
    expect(trackLineStart(true, "hello\n")).toBe(true);
  });

  test("a non-empty write NOT ending in a newline leaves us mid-line (unsafe)", () => {
    expect(trackLineStart(true, "partial delta chunk")).toBe(false);
    expect(trackLineStart(false, "partial delta chunk")).toBe(false);
  });

  test("an empty write changes nothing — no bytes actually reached the terminal", () => {
    expect(trackLineStart(true, "")).toBe(true);
    expect(trackLineStart(false, "")).toBe(false);
  });
});
