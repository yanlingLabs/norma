import type { Task } from "@norma/protocol";
import { collapseCompleted, formatElapsed, formatTokens, sortTasksForDisplay, taskGlyph } from "./task-display";
import type { CliSubagent } from "./subagent-state";
import { anySubagentAlive, subagentGlyph, subagentTokens } from "./subagent-display";

/** Glyphs for each task status — used ONLY by the non-TTY one-line-per-update render now (Task 4:
 *  the TTY pinned block switched to task-display's shared `taskGlyph`/sort/collapse so it stays in
 *  lockstep with the Swift window twin). Keyed loosely (Record<string, string>, not
 *  Record<Task["status"], string>) to match how call sites index it with an event payload's
 *  `.status` field (typed `any` at the wire boundary) without fighting TS7053. */
export const TASK_ICONS: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

// ANSI — Norma blue for the live/in-progress state (status line + in_progress glyph), green for
// completed, dim for pending/idle text, bold for the single active row's subject. Co-located here
// (rather than main.ts's own AQUA/DIM/RESET) since task-block.ts is the pure-rendering module both
// the TTY block and the status line live in; main.ts imports DIM/RESET from here instead of
// duplicating them.
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";
export const BLUE = "\x1b[38;2;115;191;255m";
export const GREEN = "\x1b[38;2;120;200;90m";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Pure upsert into the session's current task list. The daemon's task tools (task_create/
 *  task_update) emit one task_updated per task, each carrying that task's full current state —
 *  there is no batch/full-list "reset" event (unlike e.g. Claude Code's TodoWrite) — so tracking
 *  the list is just: replace-by-id, or append if this id hasn't been seen yet. Insertion order is
 *  preserved (first-created task stays first) so the block doesn't reshuffle as tasks update. */
export function upsertTask(tasks: Task[], task: Task): Task[] {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx === -1) return [...tasks, task];
  const next = tasks.slice();
  next[idx] = task;
  return next;
}

/** Width-aware truncation shared by every plain (un-colored) row this module renders — task rows
 *  AND the "… +N completed" summary row. Truncates to `columns - 2` so one logical line is always
 *  ONE physical terminal row: the erase dance (`\x1b[<n>A\x1b[0J`) counts logical lines, and a
 *  model-written subject longer than the terminal would otherwise WRAP, making the cursor-up count
 *  too small and stranding orphaned fragments mid-screen (FINAL-REVIEW FIX, 2d-ii-a). Operates on
 *  plain text — callers truncate BEFORE wrapping in ANSI color, so the visible-width budget is
 *  exact and no escape sequence is ever cut mid-code. `columns` undefined/tiny → no truncation. */
function truncatePlain(line: string, columns?: number): string {
  if (!columns || columns <= 2) return line;
  return line.length > columns - 2 ? `${line.slice(0, columns - 3)}…` : line;
}

function glyphColor(status: string): string {
  if (status === "in_progress") return BLUE;
  if (status === "completed") return GREEN;
  return DIM;
}

/** Pure block content: the Claude-Code-style task tree — in_progress first, then pending, with
 *  completed rows collapsed to the 3 most recent plus a "… +N completed" summary (shared
 *  sort/collapse rules from task-display.ts, kept in lockstep with the Swift window twin). Each
 *  row's glyph is colored by status (blue/in_progress, green/completed, dim/pending); the single
 *  in_progress row's subject is bold. Empty when there are no tasks, or when every task is
 *  completed — CC parity: the pinned block disappears once there's nothing left to do.
 *
 *  Truncation (see `truncatePlain`) happens on the plain glyph+subject text BEFORE the ANSI color
 *  is spliced back in, so a long subject never desyncs the erase math or corrupts an escape code. */
export function renderTaskBlock(tasks: Task[], columns?: number): string[] {
  if (tasks.length === 0 || tasks.every((t) => t.status === "completed")) return [];
  const { rows, collapsedCompletedCount } = collapseCompleted(sortTasksForDisplay(tasks));
  const lines = rows.map((t) => {
    const plain = truncatePlain(`${taskGlyph(t.status)} ${t.subject}`, columns);
    const glyph = plain.slice(0, 1);
    const rest = plain.slice(1); // leading space + (possibly truncated+ellipsized) subject
    const body = t.status === "in_progress" ? `${BOLD}${rest}${RESET}` : rest;
    return `${glyphColor(t.status)}${glyph}${RESET}${body}`;
  });
  if (collapsedCompletedCount > 0) {
    lines.push(`${DIM}${truncatePlain(`… +${collapsedCompletedCount} completed`, columns)}${RESET}`);
  }
  return lines;
}

function subagentGlyphColor(status: string): string {
  if (status === "working") return BLUE;
  if (status === "done") return GREEN;
  return DIM; // queued
}

/** Pure block content: the live subagent rows (2e-ii) — `● label (agentType) ↑ in ↓ out`, one per
 *  child thread of the current turn, ABOVE the task tree. Empty when nothing is alive (the block
 *  is "what's working now"; the ⌥/✓ transcript lines are the record). Done rows keep their final
 *  tokens while siblings still run. Same truncate-plain-then-color discipline as renderTaskBlock —
 *  NO time here (the active timer is window-only; tokens are the CLI's arrows). */
export function renderSubagentBlock(items: CliSubagent[], columns?: number): string[] {
  if (!anySubagentAlive(items.map((s) => s.status))) return [];
  return items.map((s) => {
    const tokens = subagentTokens(s.inputTokens, s.outputTokens, s.liveOutputChars);
    const plain = truncatePlain(`${subagentGlyph(s.status)} ${s.label} (${s.agentType})${tokens ? ` ${tokens}` : ""}`, columns);
    const glyph = plain.slice(0, 1);
    const rest = plain.slice(1);
    const body = s.status === "working" ? `${BOLD}${rest}${RESET}` : rest;
    return `${subagentGlyphColor(s.status)}${glyph}${RESET}${body}`;
  });
}

/** Pure "are we at a fresh line start" tracker. TTY-mode block erase/reprint must never happen
 *  mid partial-line (a streamed assistant delta or a bg-task-output chunk can end without a
 *  trailing newline) — corrupting a half-written line. Given the current tracked state and the
 *  exact text about to be written to stdout, this derives the new state: a write ending in "\n"
 *  puts us back at a safe fresh-line boundary; a non-empty write not ending in "\n" leaves us
 *  mid-line; an empty write changes nothing (no bytes actually went to the terminal). */
export function trackLineStart(atLineStart: boolean, text: string): boolean {
  if (text.length === 0) return atLineStart;
  return text.endsWith("\n");
}

/** State the live status line needs — everything main.ts's turn/token tracking already keeps. */
export interface StatusLineState {
  activeForm: string;
  elapsedMs: number;
  inTokens: number;
  outTokens: number;
  spinnerFrame: string;
}

/** Pure: the single-line "spinner · activeForm · elapsed · tokens" status line shown above the
 *  task tree while a turn is running (Claude-Code parity). Renders `activeForm` verbatim — the
 *  "in_progress task's activeForm, else 'Working'" fallback is the caller's job (main.ts), since
 *  this module has no notion of "the current task list", only the values it's handed. Wrapped in a
 *  single BLUE...RESET span (unlike task rows, which color only the glyph) since the whole line is
 *  transient chrome, not part of the task tree. */
export function renderStatusLine(s: StatusLineState): string {
  return `${BLUE}${s.spinnerFrame} ${s.activeForm}… (${formatElapsed(s.elapsedMs)} · ↑ ${formatTokens(s.inTokens)} ↓ ${formatTokens(s.outTokens)} tokens)${RESET}`;
}

/** Width-truncates a `renderStatusLine` result — which, unlike task rows, is wrapped in ONE color
 *  span for its entire length (`${BLUE}<visible>${RESET}`). A naive char-slice truncation (as used
 *  for task rows, which truncate plain text before adding color) would risk cutting into the
 *  trailing RESET on a narrow terminal, leaking blue into everything printed after — so this trims
 *  only the visible text between the known-length prefix/suffix and always re-appends a clean
 *  RESET. `columns` undefined/tiny, or the line already fits → unchanged. */
export function truncateStatusLine(line: string, columns?: number): string {
  if (!columns || columns <= 2) return line;
  const visible = line.slice(BLUE.length, line.length - RESET.length);
  const budget = columns - 2;
  if (visible.length <= budget) return line;
  return `${BLUE}${visible.slice(0, budget - 1)}…${RESET}`;
}
