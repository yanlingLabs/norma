import type { FooterSelection } from "./task-block";

/** The handful of actions the CLI's raw-mode stdin listener (Task 6) can take in response to a
 *  keystroke, given the current footer-focus state. Kept as its own discriminated union — rather
 *  than, say, having `footerKeyAction` mutate a passed-in `FooterSelection` — so this module stays
 *  pure (no I/O, no state) and every branch is independently testable. */
export type KeyAction =
  | { kind: "none" }
  | { kind: "interrupt" }
  | { kind: "cyclePolicy" }
  | { kind: "focusFooter" }
  | { kind: "moveFocus"; index: number }
  | { kind: "select"; threadId: string }
  | { kind: "exitFocus" };

/** Decodes one raw stdin chunk into the handful of control sequences this CLI cares about.
 *  `chunk` is typed `Buffer | string` because Node's `stdin` "data" event can hand either,
 *  depending on whether an encoding was set — normalized up front via `.toString()` (a no-op for
 *  an already-string chunk) so every comparison below is a plain string equality check, never
 *  byte-level parsing. Anything that isn't exactly one of the five recognized sequences — a bare
 *  printable char, a longer/garbled escape sequence from a fast paste, an unmapped arrow like
 *  right/left, or an empty chunk — falls through to "other". */
export function decodeKey(chunk: Buffer | string): "esc" | "up" | "down" | "enter" | "shiftTab" | "other" {
  const s = typeof chunk === "string" ? chunk : chunk.toString();
  switch (s) {
    case "\x1b":
      return "esc";
    case "\x1b[A":
      return "up";
    case "\x1b[B":
      return "down";
    case "\r":
    case "\n":
      return "enter";
    case "\x1b[Z":
      return "shiftTab";
    default:
      return "other";
  }
}

/** Pure control-key decision table for the agents footer's two modes (2e-iii-b §4 — the modal
 *  guard). `selection` is the CURRENT `FooterSelection` (read-only here — this function decides,
 *  it never mutates); `rowThreadIds` is the same main-first, live-subagents-only thread-id list
 *  the footer just rendered (Task 3's `renderAgentsFooter` row order: index 0 is always "main"),
 *  used only to clamp `moveFocus` and to resolve `enter`'s `select`.
 *
 *  Two disjoint branches keyed on `selection.focusIndex === null`:
 *
 *  FOCUS NULL (footer has no keyboard focus — only down/esc/shiftTab do anything; up/enter/other
 *  are no-ops):
 *    down     → focusFooter. The returned action carries no index — it's the CALLER's job (Task
 *               6) to seed the new `FooterSelection.focusIndex` when it handles this action,
 *               conventionally `rowThreadIds.indexOf(selection.selectedThreadId)`, falling back to
 *               0 when that returns -1 (the currently-selected thread isn't a live footer row
 *               right now). This module can't do that itself: `focusFooter` has no index field.
 *    esc      → interrupt — the ONLY place esc means interrupt (see the focus-active esc below).
 *    shiftTab → cyclePolicy.
 *    other    → none.
 *
 *  FOCUS ACTIVE (`selection.focusIndex` is a number): if `rowThreadIds` is empty — the footer
 *  vanished out from under an active focus, e.g. the last subagent finished and the turn ended
 *  between renders — EVERY key exits focus rather than risk indexing or clamping against a
 *  zero-length list. That check runs before the per-key dispatch below, so it wins even over the
 *  otherwise-unconditional shiftTab/esc mappings.
 *    up/down  → moveFocus, index clamped to [0, rowThreadIds.length - 1].
 *    enter    → select(rowThreadIds[focusIndex]) — the caller exits focus as part of handling
 *               `select`; this module doesn't also emit exitFocus for enter. Defensive: if
 *               focusIndex doesn't resolve to an id (out of range — shouldn't happen, but a
 *               resize/footer-shrink between render and keypress isn't impossible), returns none
 *               rather than throw or emit a malformed `select` with an undefined threadId.
 *    esc      → exitFocus, NEVER interrupt — the modal guard: esc while focused always backs out
 *               of focus first; it takes a SECOND esc (now with focus null) to interrupt the turn.
 *    shiftTab → cyclePolicy — works the same whether or not the footer has focus.
 *    other    → exitFocus — any unrecognized key falls through and drops focus. */
export function footerKeyAction(
  key: ReturnType<typeof decodeKey>,
  selection: FooterSelection,
  rowThreadIds: string[],
): KeyAction {
  if (selection.focusIndex === null) {
    if (key === "down") return { kind: "focusFooter" };
    if (key === "esc") return { kind: "interrupt" };
    if (key === "shiftTab") return { kind: "cyclePolicy" };
    return { kind: "none" };
  }
  if (rowThreadIds.length === 0) return { kind: "exitFocus" }; // footer gone mid-focus — any key bails out safely
  const focusIndex = selection.focusIndex;
  if (key === "up") return { kind: "moveFocus", index: Math.max(0, focusIndex - 1) };
  if (key === "down") return { kind: "moveFocus", index: Math.min(rowThreadIds.length - 1, focusIndex + 1) };
  if (key === "enter") {
    const threadId = rowThreadIds[focusIndex];
    return threadId === undefined ? { kind: "none" } : { kind: "select", threadId };
  }
  if (key === "esc") return { kind: "exitFocus" };
  if (key === "shiftTab") return { kind: "cyclePolicy" };
  return { kind: "exitFocus" }; // "other" — falls through and drops focus
}
