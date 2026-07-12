import { describe, expect, test } from "bun:test";
import { COLLAPSIBLE_TOOLS, groupBlocks, type DisplayItem } from "../../src/tui/group-blocks";
import type { Block } from "../../src/tui/state";

const read = (): Block => ({ kind: "tool", name: "read", argsJson: '{"path":"a.ts"}', output: "ok" });
const grep = (): Block => ({ kind: "tool", name: "grep", argsJson: '{"pattern":"foo"}', output: "1 match" });
const glob = (): Block => ({ kind: "tool", name: "glob", argsJson: '{"pattern":"*.ts"}', output: "a.ts" });
const ls = (): Block => ({ kind: "tool", name: "ls", argsJson: '{"path":"."}', output: "a.ts" });
const taskList = (): Block => ({ kind: "tool", name: "task_list", argsJson: "{}", output: "[]" });
const bash = (): Block => ({ kind: "tool", name: "bash", argsJson: '{"command":"ls -la"}', output: "ok" });
const assistant = (text = "hi"): Block => ({ kind: "assistant", text });

describe("COLLAPSIBLE_TOOLS", () => {
  test("is exactly read, grep, glob, ls, task_list, task_get", () => {
    expect([...COLLAPSIBLE_TOOLS].sort()).toEqual(["glob", "grep", "ls", "read", "task_get", "task_list"].sort());
  });
});

describe("groupBlocks", () => {
  test("(a) a lone read collapses to one collapsed item, summary 'Read 1 file'", () => {
    const out = groupBlocks([read()]);
    expect(out).toEqual([{ kind: "collapsed", blocks: [read()], summary: "Read 1 file" }]);
  });

  test("(b) read+read+grep run collapses to one item, summary 'Read 2 files, searched 1 pattern'", () => {
    const blocks = [read(), read(), grep()];
    const out = groupBlocks(blocks);
    expect(out).toEqual([{ kind: "collapsed", blocks, summary: "Read 2 files, searched 1 pattern" }]);
  });

  test("(c) a run broken by an assistant block produces two separate collapsed groups", () => {
    const out = groupBlocks([read(), grep(), assistant(), read()]);
    expect(out).toEqual([
      { kind: "collapsed", blocks: [read(), grep()], summary: "Read 1 file, searched 1 pattern" },
      { kind: "block", block: assistant() },
      { kind: "collapsed", blocks: [read()], summary: "Read 1 file" },
    ]);
  });

  test("(d) a non-collapsible tool (bash) passes through as a plain block", () => {
    const out = groupBlocks([bash()]);
    expect(out).toEqual([{ kind: "block", block: bash() }]);
  });

  test("(e) mixed sequence preserves order: block, collapsed run, block, collapsed run", () => {
    const b = bash();
    const a = assistant("done");
    const r1 = read();
    const r2 = grep();
    const out = groupBlocks([b, r1, r2, a]);
    expect(out).toEqual([
      { kind: "block", block: b },
      { kind: "collapsed", blocks: [r1, r2], summary: "Read 1 file, searched 1 pattern" },
      { kind: "block", block: a },
    ]);
  });

  test("(f) empty input yields empty output", () => {
    expect(groupBlocks([])).toEqual([]);
  });

  test("(g) pluralization is exact: 1 file/pattern/path vs N files/patterns/paths", () => {
    expect(groupBlocks([read()])[0]).toMatchObject({ summary: "Read 1 file" });
    expect(groupBlocks([read(), read()])[0]).toMatchObject({ summary: "Read 2 files" });
    expect(groupBlocks([grep()])[0]).toMatchObject({ summary: "Searched 1 pattern" });
    expect(groupBlocks([grep(), grep(), grep()])[0]).toMatchObject({ summary: "Searched 3 patterns" });
    expect(groupBlocks([ls()])[0]).toMatchObject({ summary: "Listed 1 path" });
    expect(groupBlocks([ls(), ls()])[0]).toMatchObject({ summary: "Listed 2 paths" });
  });

  test("glob groups under the same 'searched' category as grep", () => {
    const out = groupBlocks([grep(), glob()]);
    expect(out).toEqual([{ kind: "collapsed", blocks: [grep(), glob()], summary: "Searched 2 patterns" }]);
  });

  test("task_list/task_get summarize as 'Checked tasks' with no count", () => {
    const out = groupBlocks([taskList()]);
    expect(out).toEqual([{ kind: "collapsed", blocks: [taskList()], summary: "Checked tasks" }]);
  });

  test("an errored collapsible tool block breaks the run instead of being silently swallowed", () => {
    const erroredRead: Block = { kind: "tool", name: "read", argsJson: "{}", output: "ENOENT", isError: true };
    const out = groupBlocks([read(), erroredRead, read()]);
    expect(out).toEqual([
      { kind: "collapsed", blocks: [read()], summary: "Read 1 file" },
      { kind: "block", block: erroredRead },
      { kind: "collapsed", blocks: [read()], summary: "Read 1 file" },
    ]);
  });

  test("first-appearance order governs category order in the summary, even if categories interleave", () => {
    // grep appears first, then read, then another grep -> "Searched" leads, "read" follows lowercase
    const out = groupBlocks([grep(), read(), grep()]);
    expect(out).toEqual([
      { kind: "collapsed", blocks: [grep(), read(), grep()], summary: "Searched 2 patterns, read 1 file" },
    ]);
  });
});

// Type-level smoke check that DisplayItem's two variants are as specified.
describe("DisplayItem shape", () => {
  test("block variant carries the raw Block, collapsed variant carries blocks[] + summary", () => {
    const blockItem: DisplayItem = { kind: "block", block: bash() };
    const collapsedItem: DisplayItem = { kind: "collapsed", blocks: [read()], summary: "Read 1 file" };
    expect(blockItem.kind).toBe("block");
    expect(collapsedItem.kind).toBe("collapsed");
  });
});
