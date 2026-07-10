import { DIM, RESET } from "./task-block";

/** Task 3 (ask_user CC parity): formats one numbered option line plus, when the option carries a
 *  `preview` (the "visual scheme on the right" alongside the option), one additional indented
 *  line PER LINE of the — possibly multi-line — preview text, rendered on a "┆" rail 5 columns
 *  in (options are capped at 4 by QuestionOptionSchema, so "  N) " is always exactly 5 columns
 *  wide — the preview rail lines up under the label regardless of which option it belongs to).
 *  Pure and TTY-only: main.ts's question_asked handler calls this ONLY inside its existing
 *  `if (process.stdin.isTTY)` gate and emit()s every returned line verbatim, so the pinned
 *  block's erase/reprint bookkeeping (every emit() call already re-derives it) stays correct
 *  without any separate line-count tracking here — and headless (`-p`) never calls this function
 *  at all, so the preview text can never leak into non-TTY output. Extracted as a pure function
 *  (rather than inlined into the emit() loop) so this formatting is unit-testable without
 *  readline. The option line's own bytes are IDENTICAL to before this feature when no preview is
 *  present — a preview only ever appends extra lines, never changes the option line itself. */
export function formatOptionLines(index: number, option: { label: string; description?: string; preview?: string }): string[] {
  const lines = [`  ${index}) ${option.label}${option.description ? ` ${DIM}${option.description}${RESET}` : ""}\n`];
  if (option.preview) {
    for (const previewLine of option.preview.split("\n")) lines.push(`     ┆ ${previewLine}\n`);
  }
  return lines;
}

/** True when the raw input is exactly the menu number for "Other" (options.length + 1) — the
 *  digit itself is never a real answer, so the caller should re-prompt for actual free text
 *  instead of handing the model the literal number (M1: "Other" chosen BY NUMBER used to pass
 *  that digit straight through parseQuestionAnswer's out-of-range → free-text fallback below,
 *  which reads to the model as if the user's answer literally were e.g. "4"). Any other
 *  out-of-range number (not the Other index) is left to that same fallback, unchanged. */
export function isOtherChoice(input: string, optionsCount: number): boolean {
  return input.trim() === String(optionsCount + 1);
}

/** Map a menu input to an answer: a valid option number → its label; comma-separated numbers
 *  (multiSelect) → joined labels; anything else (incl. out-of-range) → free text, verbatim. */
export function parseQuestionAnswer(input: string, options: string[], multiSelect: boolean): string {
  const s = input.trim();
  const pick = (tok: string): string | null => {
    const n = Number(tok.trim());
    return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]! : null;
  };
  if (multiSelect && s.includes(",")) {
    const labels = s.split(",").map(pick);
    if (labels.every((l) => l !== null)) return (labels as string[]).join(", ");
    return s;
  }
  return pick(s) ?? s;
}
