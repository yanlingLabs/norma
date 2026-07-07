import { describe, expect, test } from "bun:test";
import type { Task } from "@norma/protocol";
import { taskGlyph } from "../src/task-display";
import type { CliSubagent } from "../src/subagent-state";
import {
  BLUE,
  BOLD,
  DIM,
  GREEN,
  RESET,
  SPINNER_FRAMES,
  TASK_ICONS,
  renderStatusLine,
  renderSubagentBlock,
  renderTaskBlock,
  trackLineStart,
  truncateStatusLine,
  upsertTask,
} from "../src/task-block";

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

describe("renderTaskBlock (CC tree: shared sort/collapse + colored glyphs)", () => {
  test("empty task list renders nothing", () => {
    expect(renderTaskBlock([])).toEqual([]);
  });

  test("all-completed task list renders nothing (CC parity: block disappears) — testAllCompletedEmpty", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "completed")];
    expect(renderTaskBlock(tasks)).toEqual([]);
  });

  test("in_progress row sorts first, is blue + bold; pending sorts after, dim, not bold", () => {
    const tasks = [task("1", "write tests", "pending"), task("2", "run tests", "in_progress")];
    const lines = renderTaskBlock(tasks);
    expect(lines).toEqual([
      `${BLUE}${taskGlyph("in_progress")}${RESET}${BOLD} run tests${RESET}`,
      `${DIM}${taskGlyph("pending")}${RESET} write tests`,
    ]);
  });

  test("completed rows are green, not bold; pending still sorts ahead of completed", () => {
    const tasks = [task("1", "write tests", "completed"), task("2", "ship it", "pending")];
    const lines = renderTaskBlock(tasks);
    expect(lines).toEqual([
      `${DIM}${taskGlyph("pending")}${RESET} ship it`,
      `${GREEN}${taskGlyph("completed")}${RESET} write tests`,
    ]);
  });

  test("testBlockSortsAndCollapses: 1 in_progress + 4 completed → in_progress row first (■), '… +1 completed' present (cap 3)", () => {
    const tasks = [
      task("c1", "alpha", "completed"),
      task("c2", "beta", "completed"),
      task("ip", "active one", "in_progress"),
      task("c3", "gamma", "completed"),
      task("c4", "delta", "completed"),
    ];
    const lines = renderTaskBlock(tasks);
    expect(lines[0]).toBe(`${BLUE}■${RESET}${BOLD} active one${RESET}`);
    expect(lines).toContain(`${DIM}… +1 completed${RESET}`);
    expect(lines).toHaveLength(5); // in_progress + 3 kept completed + 1 collapsed summary row
  });

  test("testBlockGlyphsBlueGreen: output contains the blue ANSI for ■ and the green ANSI for ✓", () => {
    const tasks = [task("ip", "working", "in_progress"), task("c1", "done", "completed")];
    const out = renderTaskBlock(tasks).join("\n");
    expect(out).toContain(`${BLUE}■`);
    expect(out).toContain(`${GREEN}✓`);
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

describe("renderTaskBlock width truncation (final-review fix: erase math needs 1 logical line == 1 physical row)", () => {
  const long = { id: "1", subject: "a".repeat(200), status: "pending" } as Task;

  test("a subject longer than the terminal truncates to columns-2 visible chars with an ellipsis (never wraps)", () => {
    const lines = renderTaskBlock([long], 80);
    expect(lines).toHaveLength(1);
    const prefix = `${DIM}${taskGlyph("pending")}${RESET}`;
    expect(lines[0]!.startsWith(prefix)).toBe(true);
    const rest = lines[0]!.slice(prefix.length);
    expect(rest.length).toBe(77); // (columns - 2) visible chars total, minus the 1-char glyph
    expect(rest.endsWith("…")).toBe(true);
  });

  test("short subjects pass through untouched at any width", () => {
    const short = { id: "2", subject: "ship it", status: "pending" } as Task;
    expect(renderTaskBlock([short], 80)).toEqual([`${DIM}${taskGlyph("pending")}${RESET} ship it`]);
  });

  test("undefined or tiny columns fall back to no truncation (pre-fix behavior)", () => {
    expect(renderTaskBlock([long])[0]!.length).toBeGreaterThan(100);
    expect(renderTaskBlock([long], 0)[0]!.length).toBeGreaterThan(100);
    expect(renderTaskBlock([long], 2)[0]!.length).toBeGreaterThan(100);
  });
});

describe("renderStatusLine (live turn status: spinner · elapsed · tokens)", () => {
  test("testStatusLineFormat: contains the spinner frame, activeForm, '14s', '↑', '↓', '10.6k'", () => {
    const line = renderStatusLine({
      activeForm: "Reading files",
      elapsedMs: 14000,
      inTokens: 500,
      outTokens: 10600,
      spinnerFrame: SPINNER_FRAMES[2]!,
    });
    expect(line).toContain(SPINNER_FRAMES[2]!);
    expect(line).toContain("Reading files");
    expect(line).toContain("14s");
    expect(line).toContain("↑");
    expect(line).toContain("↓");
    expect(line).toContain("10.6k");
  });

  test("the whole line is wrapped in BLUE ... RESET", () => {
    const line = renderStatusLine({ activeForm: "Working", elapsedMs: 0, inTokens: 0, outTokens: 0, spinnerFrame: SPINNER_FRAMES[0]! });
    expect(line.startsWith(BLUE)).toBe(true);
    expect(line.endsWith(RESET)).toBe(true);
  });

  test("renders activeForm verbatim (fallback to 'Working' is the caller's job)", () => {
    const line = renderStatusLine({ activeForm: "Working", elapsedMs: 0, inTokens: 0, outTokens: 0, spinnerFrame: SPINNER_FRAMES[0]! });
    expect(line).toContain("Working…");
  });
});

describe("truncateStatusLine (ANSI-safe width truncation for the caller-rendered status line)", () => {
  const full = renderStatusLine({
    activeForm: "Doing a very long thing indeed for sure and then some",
    elapsedMs: 14000,
    inTokens: 500,
    outTokens: 10600,
    spinnerFrame: SPINNER_FRAMES[0]!,
  });

  test("undefined/tiny columns: unchanged", () => {
    expect(truncateStatusLine(full)).toBe(full);
    expect(truncateStatusLine(full, 2)).toBe(full);
  });

  test("line already within budget: unchanged", () => {
    expect(truncateStatusLine(full, 500)).toBe(full);
  });

  test("narrow columns: truncates the visible text but always preserves the leading color and trailing RESET", () => {
    const truncated = truncateStatusLine(full, 30);
    expect(truncated.startsWith(BLUE)).toBe(true);
    expect(truncated.endsWith(RESET)).toBe(true);
    expect(truncated.length).toBeLessThan(full.length);
  });
});

describe("TASK_ICONS (unchanged — still used for the non-TTY one-line-per-update render)", () => {
  test("maps every status to its glyph", () => {
    expect(TASK_ICONS.pending).toBe("☐");
    expect(TASK_ICONS.in_progress).toBe("◐");
    expect(TASK_ICONS.completed).toBe("☑");
  });
});

describe("renderSubagentBlock", () => {
  const sub = (over: Partial<CliSubagent>): CliSubagent => ({
    threadId: "th_a", agentType: "general-purpose", label: "explore auth module",
    status: "working", outputTokens: 0, liveOutputChars: 0, ...over,
  });

  test("empty when no items or all done", () => {
    expect(renderSubagentBlock([])).toEqual([]);
    expect(renderSubagentBlock([sub({ status: "done" })])).toEqual([]);
  });

  test("working row: blue glyph, bold body, tokens suffix", () => {
    const [line] = renderSubagentBlock([sub({ inputTokens: 12300, outputTokens: 4100 })]);
    expect(line).toBe(`${BLUE}●${RESET}${BOLD} explore auth module (general-purpose) ↑ 12.3k ↓ 4.1k${RESET}`);
  });

  test("queued row dim with no token noise; done row keeps final tokens while siblings run", () => {
    const lines = renderSubagentBlock([sub({ status: "queued" }), sub({ threadId: "th_b", status: "done", inputTokens: 1000, outputTokens: 100 })]);
    expect(lines[0]).toBe(`${DIM}◌${RESET} explore auth module (general-purpose)`);
    expect(lines[1]).toBe(`${GREEN}✓${RESET} explore auth module (general-purpose) ↑ 1.0k ↓ 100`);
  });

  test("width truncation happens on plain text before coloring", () => {
    const [line] = renderSubagentBlock([sub({})], 20);
    expect(line!.includes("…")).toBe(true);
    expect(line!.endsWith(RESET)).toBe(true);
  });
});
