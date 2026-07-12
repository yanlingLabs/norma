/** `<CompletionMenu>` (Phase 3d Task 2) — the popup list the composer renders ABOVE its input box
 *  while slash-command mode (T3: also "@"-file mode) is active. Purely presentational: it takes the
 *  already-filtered `items` and the caller's `selected` index and renders them; ALL key handling
 *  (↑/↓ move selection, tab/enter complete-or-run, esc dismiss) lives in the composer's existing
 *  `useInput` — this component owns no stdin listener of its own (the phase's binding "single actor
 *  per key" rule).
 *
 *  Row budget: at most `maxRows` (default 6) terminal lines, EVER — `bottomBarRows` (app.tsx) bakes
 *  in `min(6, filteredCount)` as the menu's contribution to the pinned bottom bar's JS-computed
 *  height (HARD CONSTRAINT 2 from app.tsx's file doc: never lean on Yoga overflow/wrap for this
 *  region). That means every VISIBLE row here must occupy exactly one terminal line — so overlong
 *  `"{label} — {hint}"` text is hard-truncated (JS, ellipsis-terminated) rather than left to wrap.
 *  When there are more matches than `maxRows`, the render window slides to keep `selected` visible
 *  (centered when possible, clamped at the list's edges) rather than always showing the first N.
 *
 *  The selected row is rendered as accent-colored inverse video (matches the composer's own cursor
 *  cell and the theme's `accent`); the hint segment is always dim, selected or not — the same "dim
 *  secondary text" convention `task-list.tsx`/`footer.tsx` already use elsewhere in this app. */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";

export interface CompletionMenuItem {
  label: string;
  hint?: string;
}

export interface CompletionMenuProps {
  items: CompletionMenuItem[];
  selected: number;
  /** Ever-present ceiling on visible rows (the phase's fixed "≤6 rows" contract). */
  maxRows?: number;
  /** Terminal width, for the hard JS truncation described above. Defaults to 80 (matches
   *  `app.tsx`'s own `readCols` fallback) so callers that don't yet thread a live column count
   *  still get a sane truncation point instead of an unbounded string. */
  columns?: number;
}

const DEFAULT_MAX_ROWS = 6;
const DEFAULT_COLUMNS = 80;

/** The first visible index of a `rows`-tall window over `total` items that keeps `selected` inside
 *  it — centered on `selected` when there's room, clamped to `[0, total - rows]` at the edges so the
 *  window never runs off either end of the list. (`total <= rows`: the whole list fits, window is
 *  always 0.) */
function windowStart(selected: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  const centered = selected - Math.floor(rows / 2);
  return Math.max(0, Math.min(centered, total - rows));
}

/** Hard-truncates `label`/`hint` (JS, not Yoga wrap — see the file doc) so the assembled
 *  `"{label} — {hint}"` line never exceeds `columns` cells. The label is truncated only in the
 *  (rare, very-narrow-terminal) case where it alone doesn't fit; the hint is dropped/truncated
 *  first since it's the less essential half of the row. */
function truncateRow(label: string, hint: string | undefined, columns: number): { label: string; hint: string } {
  const cols = Math.max(1, columns);
  if (label.length > cols) {
    return { label: cols > 1 ? `${label.slice(0, cols - 1)}…` : label.slice(0, cols), hint: "" };
  }
  if (!hint) return { label, hint: "" };
  const sep = " — ";
  const available = cols - label.length - sep.length;
  if (available <= 0) return { label, hint: "" };
  if (hint.length <= available) return { label, hint };
  return { label, hint: available > 1 ? `${hint.slice(0, available - 1)}…` : "" };
}

export function CompletionMenu({ items, selected, maxRows = DEFAULT_MAX_ROWS, columns = DEFAULT_COLUMNS }: CompletionMenuProps) {
  if (items.length === 0) return null;
  const rows = Math.min(maxRows, items.length);
  const start = windowStart(selected, items.length, rows);
  const visible = items.slice(start, start + rows);

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const idx = start + i;
        const isSelected = idx === selected;
        const { label, hint } = truncateRow(item.label, item.hint, columns);
        return (
          <Box key={`${idx}-${item.label}`} flexDirection="row">
            <Text inverse={isSelected} color={isSelected ? theme.accent : undefined}>
              {label}
            </Text>
            {hint ? <Text dimColor>{` — ${hint}`}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
