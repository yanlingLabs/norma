import type { Task } from "@norma/protocol";

/** Glyphs for each task status — shared by the non-TTY one-line-per-update render and the
 *  TTY pinned block, so both stay visually consistent. Keyed loosely (Record<string, string>,
 *  not Record<Task["status"], string>) to match how call sites index it with an event payload's
 *  `.status` field (typed `any` at the wire boundary) without fighting TS7053. */
export const TASK_ICONS: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

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

/** Pure block content: one line per task (glyph + subject), in list order. Empty when there are
 *  no tasks, or when every task is completed — CC parity: the pinned block disappears once
 *  there's nothing left to do. Callers add ANSI styling (dim/reset) and a trailing newline per
 *  line; this stays plain text so it's trivial to assert on in tests.
 *
 *  FINAL-REVIEW FIX (width-aware erase math): each line truncates to `columns - 2` so one
 *  logical line is always ONE physical terminal row — the erase dance (`\x1b[<n>A\x1b[0J`)
 *  counts logical lines, and a model-written subject longer than the terminal would otherwise
 *  WRAP, making the cursor-up count too small and stranding orphaned fragments mid-screen.
 *  (Char-count truncation approximates display width; rare wide glyphs may render shorter than
 *  intended, never wrap. `columns` undefined/tiny → no truncation, pre-fix behavior.) */
export function renderTaskBlock(tasks: Task[], columns?: number): string[] {
  if (tasks.length === 0 || tasks.every((t) => t.status === "completed")) return [];
  const lines = tasks.map((t) => `${TASK_ICONS[t.status]} ${t.subject}`);
  if (!columns || columns <= 2) return lines;
  return lines.map((l) => (l.length > columns - 2 ? `${l.slice(0, columns - 3)}…` : l));
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
