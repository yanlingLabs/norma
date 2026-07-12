import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommittedTranscript } from "../../src/tui/transcript";
import { ActiveTurn } from "../../src/tui/active-turn";
import { StatusLine } from "../../src/tui/status-line";
import { TaskList } from "../../src/tui/task-list";
import { AgentList } from "../../src/tui/agent-list";
import { pickVerb, TURN_VERBS } from "../../src/tui/spinner-verbs";
import type { Block, AgentRow } from "../../src/tui/state";
import type { TaskRow } from "../../src/task-display";

// Phase 3b Task 3 rewrites this describe block to the CC ⏺/⎿/❯ grammar (transcript study §2).
// MIGRATION NOTE (preserves 3a's coverage intents, doesn't just delete them):
//  - 3a's "› hello there" user-prefix assertion -> now "❯ hello there" (e) below.
//  - 3a's "⚙ name args ▸ output" one-liner -> now split into a bold-name/plain-args USE line +
//    a separate dim `⎿` RESULT line (d) below.
//  - 3a's "second output line must NOT leak" intent (guarding against unbounded output dumped onto
//    one line) is migrated to the NEW cap: up to 10 lines show, the 11th+ do not, with a
//    "… +N lines (ctrl+o to expand)" note — see the 25-line-output test in (d).
//  - 3a's "ERROR: " literal prefix is gone (error state is now conveyed by the gutter/text color,
//    not a literal string); the migrated error test asserts CONTENT only, matching the brief's
//    explicit "assert content, not ANSI" instruction for that case.
describe("CommittedTranscript — assistant block (c)", () => {
  test("renders the ⏺ gutter + a markdown-rendered body (bold applied, raw ** markers gone)", () => {
    const items: Block[] = [{ kind: "assistant", text: "hi **there**, friend" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    expect(frame).toContain("hi");
    expect(frame).toContain("there");
    expect(frame).toContain("friend");
    expect(frame).not.toContain("**there**"); // markdown was rendered (bolded), not left as literal text
  });
});

describe("CommittedTranscript — tool block (d)", () => {
  test("bold name + (args) + ⎿ result, capped at 10 lines with a '+N lines' truncation note", () => {
    const output = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: '{"command":"ls -la"}', output, isError: false }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bash");
    expect(frame).toContain('({"command":"ls -la"})');
    expect(frame).toContain("⎿");
    for (let i = 0; i < 10; i++) expect(frame).toContain(`line${i}`);
    for (let i = 10; i < 25; i++) expect(frame).not.toContain(`line${i}`);
    expect(frame).toContain("… +15 lines (ctrl+o to expand)");
  });

  test("an errored tool block still renders its output content (error state is color-only now, no 'ERROR:' literal)", () => {
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: "{}", output: "boom", isError: true }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("boom");
    expect(frame).not.toContain("ERROR:");
  });

  test("empty argsJson renders the bare tool name with no parens", () => {
    const items: Block[] = [{ kind: "tool", name: "bash", argsJson: "", output: "ok" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bash");
    expect(frame).not.toContain("()");
  });
});

describe("CommittedTranscript — user block (e)", () => {
  test("shows ❯ + text", () => {
    const items: Block[] = [{ kind: "user", text: "hello there" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    expect(lastFrame() ?? "").toContain("❯ hello there");
  });
});

describe("CommittedTranscript — note block", () => {
  test("dim ✻ prefix + text (agent-finish-note WORDING is untouched by this task — only the glyph prefix is added)", () => {
    const items: Block[] = [{ kind: "note", text: 'Agent "refactor widget" finished · 14s\n⎿ Ran 1 tool calls' }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✻");
    expect(frame).toContain('Agent "refactor widget" finished · 14s');
    expect(frame).toContain("Ran 1 tool calls");
  });
});

describe("CommittedTranscript — turn-summary block (f)", () => {
  test("renders ✻ + verb + 'for 12s' + ↑13.7k ↓149 tokens", () => {
    const items: Block[] = [{ kind: "turn-summary", durationMs: 12_000, inTokens: 13_700, outTokens: 149 }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✻");
    expect(frame).toContain(pickVerb(TURN_VERBS, 12_000));
    expect(frame).toContain("for 12s");
    expect(frame).toContain("↑13.7k");
    expect(frame).toContain("↓149");
    expect(frame).toContain("tokens");
  });
});

describe("CommittedTranscript — interrupted block (g)", () => {
  test("exact wording", () => {
    const items: Block[] = [{ kind: "interrupted" }];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    expect(lastFrame() ?? "").toContain("Interrupted · What should Norma do instead?");
  });
});

describe("AgentList (b)", () => {
  test("a DONE agent row shows its persisted label/stats, not empty/0s", () => {
    const row: AgentRow = {
      threadId: "th_1",
      agentType: "general-purpose",
      label: "scout",
      status: "done",
      outputTokens: 120,
      liveOutputChars: 0,
      activeMs: 9000,
      toolCalls: 3,
    };
    const { lastFrame } = render(<AgentList agents={[row]} nowMs={999_999} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("scout");
    expect(frame).toContain("9s");
    expect(frame).toContain("3 tools");
    expect(frame).not.toContain("0s");
  });

  test("hidden when there are no agents", () => {
    const { lastFrame } = render(<AgentList agents={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("StatusLine (c)", () => {
  test("running shows elapsed + tokens", () => {
    const { lastFrame } = render(
      <StatusLine running turnStartMs={0} nowMs={12_000} inTokens={13_700} outTokens={149} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("12s");
    expect(frame).toContain("13.7k");
    expect(frame).toContain("149");
  });

  test("hidden when not running", () => {
    const { lastFrame } = render(
      <StatusLine running={false} turnStartMs={0} nowMs={12_000} inTokens={13_700} outTokens={149} />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("TaskList (d)", () => {
  test("hidden when empty", () => {
    const { lastFrame } = render(<TaskList tasks={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("two tasks: both glyphs+subjects render", () => {
    const tasks: TaskRow[] = [
      { id: "1", subject: "Write tests", status: "in_progress" },
      { id: "2", subject: "Ship feature", status: "pending" },
    ];
    const { lastFrame } = render(<TaskList tasks={tasks} nowMs={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("■");
    expect(frame).toContain("Write tests");
    expect(frame).toContain("☐");
    expect(frame).toContain("Ship feature");
  });
});

// Phase 3b Task 3 rewrite: streaming assistant text now goes through splitStableBoundary +
// renderMarkdown (migrating 3a's plain-cyan-text coverage), and in-flight tools render the
// CC-style `bold name(argsHead)` USE line instead of the 3a `⚙ name args` one-liner, with a
// blinking (nowMs-parity) gutter dot — (h) below is the brief's new required case.
describe("ActiveTurn — streaming assistant text (memoized stable prefix)", () => {
  test("renders a completed leading paragraph (stable, markdown-rendered) plus a growing partial tail", () => {
    const { lastFrame } = render(
      <ActiveTurn assistant={"First **para** complete.\n\nSecond para partial"} tools={[]} nowMs={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("First");
    expect(frame).toContain("para"); // bold marker rendered, not left literal
    expect(frame).not.toContain("**para**");
    expect(frame).toContain("complete.");
    expect(frame).toContain("Second para partial");
  });

  test("hidden when idle (no assistant text, no in-flight tools)", () => {
    const { lastFrame } = render(<ActiveTurn assistant="" tools={[]} nowMs={0} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("ActiveTurn — in-flight tools (bold name(argsHead160) + blinking dot) (h)", () => {
  test("renders bold tool name + args head alongside the gutter dot", () => {
    const { lastFrame } = render(
      <ActiveTurn assistant="" tools={[{ name: "bash", argsJson: '{"command":"ls"}' }]} nowMs={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺");
    expect(frame).toContain("bash");
    expect(frame).toContain('({"command":"ls"})');
  });

  test("(h) the gutter dot's dim/normal state flips across two nowMs values 500ms apart, and returns at 1000ms", () => {
    const tools = [{ name: "bash", argsJson: '{"command":"ls"}' }];
    const { lastFrame, rerender } = render(<ActiveTurn assistant="" tools={tools} nowMs={0} />);
    const frameAt0 = lastFrame() ?? "";

    rerender(<ActiveTurn assistant="" tools={tools} nowMs={500} />);
    const frameAt500 = lastFrame() ?? "";
    expect(frameAt500).not.toBe(frameAt0); // parity flipped -> different dim styling

    rerender(<ActiveTurn assistant="" tools={tools} nowMs={1000} />);
    expect(lastFrame() ?? "").toBe(frameAt0); // parity flipped back -> byte-identical to nowMs=0
  });
});
