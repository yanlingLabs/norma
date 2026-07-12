import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Spinner, spinnerFrame } from "../../src/tui/spinner";
import { pickVerb, SPINNER_VERBS } from "../../src/tui/spinner-verbs";
import { formatElapsed, formatTokens, type TaskRow } from "../../src/task-display";

describe("spinnerFrame — pure glyph-cycle index math (b)", () => {
  test("forward half: · ✢ ✳ ✶ ✻ ✽ at 0/120/240/360/480/600ms", () => {
    expect(spinnerFrame(0)).toBe("·");
    expect(spinnerFrame(120)).toBe("✢");
    expect(spinnerFrame(240)).toBe("✳");
    expect(spinnerFrame(360)).toBe("✶");
    expect(spinnerFrame(480)).toBe("✻");
    expect(spinnerFrame(600)).toBe("✽");
  });

  test("reverse half: ✽ ✻ ✶ ✳ ✢ · at 720/840/960/1080/1200/1320ms", () => {
    expect(spinnerFrame(720)).toBe("✽");
    expect(spinnerFrame(840)).toBe("✻");
    expect(spinnerFrame(960)).toBe("✶");
    expect(spinnerFrame(1080)).toBe("✳");
    expect(spinnerFrame(1200)).toBe("✢");
    expect(spinnerFrame(1320)).toBe("·");
  });

  test("wraps back to the start of a fresh 12-entry cycle at 1440ms", () => {
    expect(spinnerFrame(1440)).toBe(spinnerFrame(0));
  });

  test("two frames 120ms apart differ", () => {
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(120));
  });

  test("any millisecond offset within a 120ms window maps to the same glyph", () => {
    expect(spinnerFrame(100)).toBe(spinnerFrame(0));
    expect(spinnerFrame(719)).toBe(spinnerFrame(600));
  });
});

describe("Spinner (a, c, d)", () => {
  test("(a) hidden entirely when not running", () => {
    const { lastFrame } = render(
      <Spinner running={false} turnStartMs={0} nowMs={1000} outTokens={0} tasks={[]} />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("(c) verb is the in-progress task's subject when one exists", () => {
    const tasks: TaskRow[] = [
      { id: "1", subject: "Ship feature", status: "in_progress" },
      { id: "2", subject: "Write tests", status: "pending" },
    ];
    const { lastFrame } = render(
      <Spinner running turnStartMs={0} nowMs={0} outTokens={0} tasks={tasks} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ship feature…");
  });

  test("(c) falls back to a deterministic verb from SPINNER_VERBS when no task is in progress", () => {
    const { lastFrame } = render(
      <Spinner running turnStartMs={42} nowMs={42} outTokens={0} tasks={[]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`${pickVerb(SPINNER_VERBS, 42)}…`);
  });

  test("(d) byline contains 'esc to interrupt' and the elapsed time; no tokens segment while outTokens is 0", () => {
    const { lastFrame } = render(
      <Spinner running turnStartMs={0} nowMs={12_000} outTokens={0} tasks={[]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("esc to interrupt");
    expect(frame).toContain(formatElapsed(12_000));
    expect(frame).not.toContain("tokens");
  });

  test("(d) tokens segment appears once outTokens > 0", () => {
    const { lastFrame } = render(
      <Spinner running turnStartMs={0} nowMs={12_000} outTokens={149} tasks={[]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("esc to interrupt");
    expect(frame).toContain(formatElapsed(12_000));
    expect(frame).toContain(`↓ ${formatTokens(149)} tokens`);
  });
});
