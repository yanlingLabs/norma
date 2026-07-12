/** `<TaskList>` (Phase 3a Task 3) — the pinned task tree (`TuiState.tasks`, raw/unsorted per Task
 *  2's reducer), rendered here in Claude-Code order: `sortTasksForDisplay` → `collapseCompleted`
 *  (both from `task-display.ts`, shared lockstep with the Swift window twin), one row per surviving
 *  task (`{taskGlyph} {subject}`), preceded by the `taskCountsLine` count header. Hidden entirely
 *  when there are no tasks at all.
 *
 *  `nowMs` is part of this component's prop shape (per the brief's interface) but unused for now —
 *  no per-row elapsed time is rendered at this layer today; reserved for a later task. Pure — no
 *  client, no side effects, no `Date.now()`. */

import React from "react";
import { Box, Text } from "ink";
import { collapseCompleted, sortTasksForDisplay, taskCountsLine, taskGlyph, type TaskRow } from "../task-display";

export function TaskList({ tasks, nowMs }: { tasks: TaskRow[]; nowMs: number }) {
  void nowMs;
  if (tasks.length === 0) return null;
  const { rows } = collapseCompleted(sortTasksForDisplay(tasks));
  return (
    <Box flexDirection="column">
      <Text dimColor>{taskCountsLine(tasks)}</Text>
      {rows.map((t) => (
        <Text key={t.id}>
          {taskGlyph(t.status)} {t.subject}
        </Text>
      ))}
    </Box>
  );
}
