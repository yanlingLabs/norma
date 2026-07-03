// Pure parser for the plan-approval menu's stdin line (see plan_presented render in main.ts).
// "1" → approve, review each edit; "2" → approve + auto-accept edits; "3"/"3 <reason>" → reject
// with the reason as feedback; anything else is treated as a rejection with the raw text as
// feedback (mirrors parseQuestionAnswer's "free text = an answer" leniency in questions.ts).
export function parsePlanResponse(input: string): { approved: boolean; autoAccept: boolean; feedback?: string } {
  const s = input.trim();
  if (s === "1") return { approved: true, autoAccept: false };
  if (s === "2") return { approved: true, autoAccept: true };
  if (s === "3" || s.startsWith("3 ")) {
    const fb = s.slice(1).trim();
    return { approved: false, autoAccept: false, feedback: fb || undefined };
  }
  return { approved: false, autoAccept: false, feedback: s || undefined }; // any other text = reject with it as feedback
}
