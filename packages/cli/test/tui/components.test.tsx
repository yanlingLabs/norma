import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommittedTranscript } from "../../src/tui/transcript";
import { ActiveTurn } from "../../src/tui/active-turn";
import { StatusLine } from "../../src/tui/status-line";
import { TaskList } from "../../src/tui/task-list";
import { AgentList } from "../../src/tui/agent-list";
import type { Block, AgentRow } from "../../src/tui/state";
import type { TaskRow } from "../../src/task-display";

describe("CommittedTranscript (a)", () => {
  test("renders one line per block, mirroring main.ts's glyphs/prefixes", () => {
    const items: Block[] = [
      { kind: "user", text: "hello there" },
      { kind: "assistant", text: "hi! how can I help" },
      { kind: "tool", name: "bash", argsJson: '{"command":"ls -la"}', output: "total 12\nfile.txt", isError: false },
      { kind: "note", text: "+ dir /tmp (remembered)" },
    ];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("› hello there");
    expect(frame).toContain("hi! how can I help");
    expect(frame).toContain("⚙ bash");
    expect(frame).toContain('{"command":"ls -la"}');
    expect(frame).toContain("total 12"); // tool_result: first line of output only (main.ts parity)
    expect(frame).not.toContain("file.txt"); // second output line must NOT leak onto the one-liner
    expect(frame).toContain("+ dir /tmp (remembered)");
  });

  test("an errored tool block is prefixed ERROR:", () => {
    const items: Block[] = [
      { kind: "tool", name: "bash", argsJson: "{}", output: "boom", isError: true },
    ];
    const { lastFrame } = render(<CommittedTranscript items={items} />);
    expect(lastFrame() ?? "").toContain("ERROR: boom");
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

// Not enumerated in the brief's Step 1 (a)-(d), but ActiveTurn is one of the five components this
// task must implement (Step 3) — a minimal case guards it against shipping with zero coverage.
describe("ActiveTurn (added — not in the brief's a-d list)", () => {
  test("streaming assistant text + an in-flight tool one-liner", () => {
    const { lastFrame } = render(
      <ActiveTurn assistant="thinking it over" tools={[{ name: "bash", argsJson: '{"command":"ls"}' }]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("thinking it over");
    expect(frame).toContain("⚙ bash");
    expect(frame).toContain('{"command":"ls"}');
  });

  test("hidden when idle (no assistant text, no in-flight tools)", () => {
    const { lastFrame } = render(<ActiveTurn assistant="" tools={[]} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
