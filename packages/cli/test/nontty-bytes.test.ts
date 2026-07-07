import { describe, expect, test } from "bun:test";
import { NONTTY_TASK_LINE, NONTTY_SPAWN_LINE, NONTTY_FINISH_LINE } from "../src/task-block";

// Byte-equality pin (2e-iii-b design §9 "Non-TTY byte-equality"; closes the 2e-ii final-review
// minor "no non-TTY test pin"). main.ts's non-TTY (piped/`-p`) branches for task_updated /
// thread_started / thread_completed call these SAME three functions, so any drift in the frozen
// literals below breaks this test. Escapes are hard-coded (not `${DIM}` etc.) on purpose: this is
// the wire contract headless consumers parse, asserted to the exact byte.
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

describe("NONTTY_TASK_LINE — task_updated non-TTY line", () => {
  test("pending / in_progress / completed glyphs, dim-wrapped, trailing newline", () => {
    expect(NONTTY_TASK_LINE("pending", "Write the parser")).toBe(`${DIM}☐ Write the parser${RESET}\n`);
    expect(NONTTY_TASK_LINE("in_progress", "Building the parser")).toBe(`${DIM}◐ Building the parser${RESET}\n`);
    expect(NONTTY_TASK_LINE("completed", "Wrote the parser")).toBe(`${DIM}☑ Wrote the parser${RESET}\n`);
  });

  test("exact raw bytes (no interpolation) for the common in_progress case", () => {
    expect(NONTTY_TASK_LINE("in_progress", "Building the parser")).toBe("\x1b[2m◐ Building the parser\x1b[0m\n");
  });
});

describe("NONTTY_SPAWN_LINE — thread_started non-TTY line", () => {
  test("dim-wrapped ⌥ spawned <agentType> subagent, trailing newline", () => {
    expect(NONTTY_SPAWN_LINE("general-purpose")).toBe(`${DIM}⌥ spawned general-purpose subagent${RESET}\n`);
  });

  test("exact raw bytes (no interpolation)", () => {
    expect(NONTTY_SPAWN_LINE("general-purpose")).toBe("\x1b[2m⌥ spawned general-purpose subagent\x1b[0m\n");
  });
});

describe("NONTTY_FINISH_LINE — thread_completed non-TTY line", () => {
  test("end_turn omits the stop-reason suffix", () => {
    expect(NONTTY_FINISH_LINE("end_turn")).toBe(`${DIM}✓ subagent done${RESET}\n`);
    expect(NONTTY_FINISH_LINE("end_turn")).toBe("\x1b[2m✓ subagent done\x1b[0m\n");
  });

  test("a non-end_turn stop reason appends it in parens", () => {
    expect(NONTTY_FINISH_LINE("aborted")).toBe(`${DIM}✓ subagent done (aborted)${RESET}\n`);
    expect(NONTTY_FINISH_LINE("error")).toBe(`${DIM}✓ subagent done (error)${RESET}\n`);
    expect(NONTTY_FINISH_LINE("aborted")).toBe("\x1b[2m✓ subagent done (aborted)\x1b[0m\n");
  });
});
