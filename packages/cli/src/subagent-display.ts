/** Shared pure subagent-display logic (Phase 2e-ii) — glyph/label/alive are LOCKSTEP with
 *  `apple/Norma/Sources/ChatContent/SubagentDisplay.swift` (same fixtures both sides, like
 *  task-display.ts). `subagentTokens` is TS-ONLY: token arrows render only in the CLI (the window
 *  shows time instead — its Swift-only twin is `subagentActiveMs`). Pure — no ANSI, no I/O. */

import { formatTokens } from "./task-display";

export function subagentGlyph(status: string): string {
  if (status === "working") return "●";
  if (status === "done") return "✓";
  return "◌"; // queued, or any unrecognized status
}

/** description (trimmed) if non-empty, else the prompt's FIRST line capped at 40 UNICODE CODE
 *  POINTS with a trailing "…" (39 kept + ellipsis; exactly 40 fits untruncated). Code points
 *  (not UTF-16 units, not grapheme clusters) count identically in TS (`Array.from`) and Swift
 *  (`unicodeScalars`) and never split a surrogate pair. */
export function subagentLabel(description: string | undefined, prompt: string): string {
  const desc = (description ?? "").trim();
  if (desc.length > 0) return desc;
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const cps = Array.from(firstLine);
  return cps.length > 40 ? `${cps.slice(0, 39).join("")}…` : firstLine;
}

export function anySubagentAlive(statuses: string[]): boolean {
  return statuses.some((s) => s !== "done");
}

/** "↑ <in> ↓ <out>" — ↓ is banked outputTokens + ceil(liveOutputChars/4) (same live-estimate
 *  convention as the 2e-i status line); ↑ omitted until the child's first turn_completed reports
 *  inputTokens; empty string when nothing is known yet (a queued row shows no token noise). */
export function subagentTokens(inputTokens: number | undefined, outputTokens: number, liveOutputChars: number): string {
  const down = outputTokens + Math.ceil(liveOutputChars / 4);
  if (inputTokens === undefined) return down === 0 ? "" : `↓ ${formatTokens(down)}`;
  return `↑ ${formatTokens(inputTokens)} ↓ ${formatTokens(down)}`;
}
