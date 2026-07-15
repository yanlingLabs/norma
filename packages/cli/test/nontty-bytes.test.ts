import { describe, expect, test } from "bun:test";
import { NONTTY_TASK_LINE, NONTTY_SPAWN_LINE, NONTTY_FINISH_LINE } from "../src/task-block";
import { formatOptionLines, parseQuestionAnswer } from "../src/questions";

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

  // T3 review fix wave 1: task_update{status:"deleted"} now emits a task_updated event, so this
  // non-TTY (append-only) line renders it too — pinned so it never regresses to the literal
  // string "undefined" for the glyph.
  test("deleted glyph, dim-wrapped, trailing newline", () => {
    expect(NONTTY_TASK_LINE("deleted", "Throwaway task")).toBe(`${DIM}✗ Throwaway task${RESET}\n`);
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

  // task-16 (Stalled roster verb): this helper is generic over the stopReason string — it already
  // renders any non-"end_turn" value parenthetically, no code change needed for the new "stalled"
  // wire value. This pins that guarantee explicitly.
  test("the new 'stalled' stop reason (task-16) appends it in parens too, with no special-casing needed", () => {
    expect(NONTTY_FINISH_LINE("stalled")).toBe(`${DIM}✓ subagent done (stalled)${RESET}\n`);
  });
});

// question_asked has NO non-TTY line at all — unlike task_updated/thread_started/thread_completed
// above, main.ts's whole question renderer (options, previews, the note prompt) sits behind a
// single `if (process.stdin.isTTY)` gate and is a complete no-op when it's false: headless (`-p`)
// relies on QuestionBroker's server-side timeout (packages/core/src/agent/questions.ts) to resolve
// the question, never on CLI-side rendering or answering. Task 3 (option preview + note prompt)
// added lines ONLY inside that same pre-existing gate, so this invariant — zero bytes for
// question_asked when !isTTY — is unchanged. There is deliberately no NONTTY_QUESTION_LINE to pin
// (there was never non-TTY question output to begin with); instead this pins the two production
// functions a headless answer path would have to go through if one ever existed, proving a
// preview can't leak into either:
describe("question_asked — no non-TTY renderer exists (Task 3: preview/note additions don't change that)", () => {
  test("formatOptionLines (the new TTY-only preview formatter) is additive-only: with no `preview`, the option line is byte-identical to the pre-Task-3 inline format", () => {
    expect(formatOptionLines(1, { label: "Falcon" })).toEqual(["  1) Falcon\n"]);
  });

  test("parseQuestionAnswer (the answer-computation function, called from both the TTY branch and — were one ever added — a headless one) only ever sees option LABELS, never `preview` text, so a preview can't alter the computed answer either way", () => {
    const labels = ["Falcon", "Osprey", "Heron"]; // main.ts extracts labels via q.options.map(o => o.label) — preview is never passed in
    expect(parseQuestionAnswer("2", labels, false)).toBe("Osprey");
  });
});
