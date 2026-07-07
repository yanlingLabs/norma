import { describe, expect, test } from "bun:test";
import { sortTasksForDisplay, collapseCompleted, taskGlyph, formatElapsed, formatTokens } from "../src/task-display";
const t = (id: string, status: string) => ({ id, subject: id, status });
describe("task-display", () => {
  test("sort: in_progress → pending → completed, stable", () => {
    const r = sortTasksForDisplay([t("a","completed"),t("b","pending"),t("c","in_progress"),t("d","pending")]);
    expect(r.map(x=>x.id)).toEqual(["c","b","d","a"]);
  });
  test("collapse: all incomplete + 2 completed, rest counted", () => {
    const sorted = sortTasksForDisplay([t("p1","pending"),t("ip","in_progress"),t("c1","completed"),t("c2","completed"),t("c3","completed")]);
    const r = collapseCompleted(sorted);
    expect(r.rows.map(x=>x.id)).toEqual(["ip","p1","c1","c2"]);
    expect(r.collapsedCompletedCount).toBe(1);
  });
  test("collapse: ≤2 completed shows all, count 0", () => {
    const r = collapseCompleted(sortTasksForDisplay([t("c1","completed"),t("c2","completed")]));
    expect(r.collapsedCompletedCount).toBe(0);
  });
  test("glyphs", () => { expect(taskGlyph("in_progress")).toBe("■"); expect(taskGlyph("completed")).toBe("✓"); expect(taskGlyph("pending")).toBe("☐"); expect(taskGlyph("weird")).toBe("☐"); });
  test("formatElapsed", () => { expect(formatElapsed(14000)).toBe("14s"); expect(formatElapsed(123000)).toBe("2m 3s"); expect(formatElapsed(3840000)).toBe("1h 4m"); });
  test("formatTokens", () => { expect(formatTokens(842)).toBe("842"); expect(formatTokens(10600)).toBe("10.6k"); expect(formatTokens(1200000)).toBe("1.2M"); });
});
