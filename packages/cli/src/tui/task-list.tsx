/** `<TaskList>` (Phase 3b Task 6) — the CC-style task view rendered inside the spinner area behind
 *  `ctrl+t` (T7 wires the actual toggle; this component just renders `TuiState.tasks` given
 *  `tasksVisible`). Order/collapse is still `sortTasksForDisplay` → `collapseCompleted` (both from
 *  `task-display.ts`, shared lockstep with the Swift window twin, READ-only from here) preceded by
 *  the `taskCountsLine` count header — that part is unchanged from 3a.
 *
 *  What changes from 3a is the per-row GLYPH/STYLE, matched to the CC study's `TaskListV2.tsx`
 *  (`cc-ui-study-chrome.md` §4, adapted not copied): done → `✔` (`theme.success`) + subject
 *  strikethrough+dim; in-progress → a filled `◼` square (`theme.accent`) + subject BOLD; pending →
 *  a hollow `◻` square, plain. These are deliberately DIFFERENT glyphs from `task-display.ts`'s own
 *  `taskGlyph` (■/✓/☐, used by the legacy `task-block.ts` TTY block) — that shared helper stays
 *  Swift-lockstep and untouched; this component owns its own CC-flavored glyph choice instead of
 *  calling it.
 *
 *  `collapseCompleted`'s `collapsedCompletedCount` (the number of older completed rows folded away
 *  behind the kept-3 window) surfaces as one dim overflow line under the rows, when > 0.
 *
 *  `nowMs` is part of this component's prop shape (per the brief's interface) but unused for now —
 *  no per-row elapsed time is rendered at this layer today; reserved for a later task. Pure — no
 *  client, no side effects, no `Date.now()`. */

import React from "react";
import { Box, Text } from "ink";
import { collapseCompleted, sortTasksForDisplay, taskCountsLine, type TaskRow } from "../task-display";
import { theme } from "./theme";

function TaskRowView({ task }: { task: TaskRow }) {
  if (task.status === "completed") {
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>{"✔ "}</Text>
        <Text dimColor strikethrough>
          {task.subject}
        </Text>
      </Box>
    );
  }
  if (task.status === "in_progress") {
    return (
      <Box flexDirection="row">
        <Text color={theme.accent}>{"◼ "}</Text>
        <Text bold>{task.subject}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="row">
      <Text>{"◻ "}</Text>
      <Text>{task.subject}</Text>
    </Box>
  );
}

export function TaskList({ tasks, nowMs }: { tasks: TaskRow[]; nowMs: number }) {
  void nowMs;
  if (tasks.length === 0) return null;
  const { rows, collapsedCompletedCount } = collapseCompleted(sortTasksForDisplay(tasks));
  return (
    <Box flexDirection="column">
      <Text dimColor>{taskCountsLine(tasks)}</Text>
      {rows.map((t) => (
        <TaskRowView key={t.id} task={t} />
      ))}
      {collapsedCompletedCount > 0 ? <Text dimColor>{`… +${collapsedCompletedCount} completed`}</Text> : null}
    </Box>
  );
}
