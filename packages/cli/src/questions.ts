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
