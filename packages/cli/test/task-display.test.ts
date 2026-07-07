import { describe, expect, test } from "bun:test";
import { sortTasksForDisplay, collapseCompleted, taskGlyph, formatElapsed, formatTokens, taskCountsLine } from "../src/task-display";
const t = (id: string, status: string) => ({ id, subject: id, status });
const row = t;
describe("task-display", () => {
  test("sort: in_progress → pending → completed, stable", () => {
    const r = sortTasksForDisplay([t("a","completed"),t("b","pending"),t("c","in_progress"),t("d","pending")]);
    expect(r.map(x=>x.id)).toEqual(["c","b","d","a"]);
  });
  test("collapse: all incomplete + 3 completed (at cap), shows all, count 0", () => {
    const sorted = sortTasksForDisplay([t("p1","pending"),t("ip","in_progress"),t("c1","completed"),t("c2","completed"),t("c3","completed")]);
    const r = collapseCompleted(sorted);
    expect(r.rows.map(x=>x.id)).toEqual(["ip","p1","c1","c2","c3"]);
    expect(r.collapsedCompletedCount).toBe(0);
  });
  test("collapse: ≤3 completed shows all, count 0", () => {
    const r = collapseCompleted(sortTasksForDisplay([t("c1","completed"),t("c2","completed"),t("c3","completed")]));
    expect(r.rows.map(x=>x.id)).toEqual(["c1","c2","c3"]);
    expect(r.collapsedCompletedCount).toBe(0);
  });
  test("collapse cap is 3 (CC parity)", () => {
    const sorted = sortTasksForDisplay([row("ip", "in_progress"), row("c1", "completed"), row("c2", "completed"), row("c3", "completed"), row("c4", "completed"), row("c5", "completed")]);
    const r = collapseCompleted(sorted);
    expect(r.rows.map((t) => t.id)).toEqual(["ip", "c1", "c2", "c3"]);
    expect(r.collapsedCompletedCount).toBe(2);
  });
  test("taskCountsLine", () => {
    expect(taskCountsLine([row("a", "completed"), row("b", "in_progress"), row("c", "pending"), row("d", "weird")]))
      .toBe("4 tasks (1 done, 1 in progress, 2 open)");
    expect(taskCountsLine([])).toBe("0 tasks (0 done, 0 in progress, 0 open)");
  });
  test("glyphs", () => { expect(taskGlyph("in_progress")).toBe("■"); expect(taskGlyph("completed")).toBe("✓"); expect(taskGlyph("pending")).toBe("☐"); expect(taskGlyph("weird")).toBe("☐"); });
  test("formatElapsed", () => { expect(formatElapsed(14000)).toBe("14s"); expect(formatElapsed(123000)).toBe("2m 3s"); expect(formatElapsed(3840000)).toBe("1h 4m"); });
  test("formatTokens", () => { expect(formatTokens(842)).toBe("842"); expect(formatTokens(10600)).toBe("10.6k"); expect(formatTokens(1200000)).toBe("1.2M"); });
});

import { formatTokens as ftok } from "../src/task-display";
describe("formatTokens lockstep (Task-1 review: no half-even/half-up divergence)", () => {
  test("the divergent binary-tie cases now round consistently (half-up)", () => {
    expect(ftok(1250)).toBe("1.3k");   // was the divergence: %.1f gave 1.2k
    expect(ftok(2250)).toBe("2.3k");
    expect(ftok(12250)).toBe("12.3k");
    expect(ftok(100250)).toBe("100.3k");
    expect(ftok(1250000)).toBe("1.3M");
  });
  test("original fixtures unchanged", () => {
    expect(ftok(842)).toBe("842");
    expect(ftok(10600)).toBe("10.6k");
    expect(ftok(1200000)).toBe("1.2M");
  });
  test("non-tie values still correct", () => {
    expect(ftok(1000)).toBe("1.0k");
    expect(ftok(1240)).toBe("1.2k");
    expect(ftok(1249)).toBe("1.2k");
  });
});
