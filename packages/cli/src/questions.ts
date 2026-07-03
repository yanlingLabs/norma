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
