/** Fullscreen shell SPIKE (phase 3c Task 1 — the phase's de-risking gate). A minimal fixed-height
 *  Ink tree proving the load-bearing layout invariant the real T4 shell depends on: a root sized to
 *  EXACTLY `rows - 1` (never `rows`) with a `flexGrow` content region above a pinned bottom line.
 *
 *  Why `rows - 1` and not `rows`: Ink's own render loop (verified in ink@5.2.1 `ink.js` `onRender`)
 *  writes `ansiEscapes.clearTerminal` — which erases the terminal's SCROLLBACK too (`\x1b[3J`), not
 *  just the visible screen — whenever a frame's `outputHeight >= stdout.rows`. `outputHeight` is
 *  exactly the ROOT node's Yoga-computed height (`renderer.js`: `new Output({height:
 *  node.yogaNode.getComputedHeight()})`), and Yoga treats an explicit numeric `height` as a hard
 *  constraint on that node's OWN box regardless of children content — so fixing the root at
 *  `rows - 1` keeps `outputHeight` at `rows - 1 < rows` deterministically, off that branch. This part
 *  held up under test (b)'s 100-line overflow in every variant tried below.
 *
 *  UNSOUND DISCOVERY, folded into this design (see task report for the full writeup): overflow
 *  clipping alone does NOT safely truncate an overflowing `flexGrow` region here. Two things were
 *  tried and both broke the pinned-bottom invariant:
 *   1. Bare Text children (Ink's default flex-shrink, which Box.js defaults to `1`): once natural
 *      content height (100 rows) exceeds the region's flex-allotted height (rows-2), Yoga SHRINKS
 *      every child instead of overflowing past the boundary — computed tops become fractional,
 *      round to colliding integer rows, and the frame shows a scattered subsequence of lines with
 *      later ones winning ties (e.g. "line-5", "line-10", "line-15", ... instead of "line-0"..").
 *   2. Text children pinned to `flexShrink={0}` (refusing to shrink): Yoga then grows the flexGrow
 *      region's effective content past its flex-allotted share, which pushes the BOTTOM sibling's
 *      own absolute row past the root's last valid index — BOTTOM's write silently lands outside the
 *      pre-sized output buffer and vanishes from the frame entirely (verified directly: content with
 *      exactly `rows-2` lines pins BOTTOM correctly, `rows-1` lines makes BOTTOM disappear).
 *  The fix that actually holds (and the one used below) is what `pager.tsx`'s `pagerWindowRows`/
 *  `pagerViewport` already do for the ctrl+o pager: WINDOW the content to the available row budget
 *  in plain JS *before* handing it to Ink, so Yoga never needs to shrink or overflow anything —
 *  `overflow="hidden"` on the region is kept only as a defensive backstop (e.g. a single wrapped long
 *  line), not as the truncation mechanism itself. T4 must window every dynamic region the same way;
 *  it cannot lean on Ink's overflow clipping for correctness.
 *
 *  `rows` is a controlled prop, not read from `stdout.rows` internally — the real shell drives it
 *  from a live app-level `stdout.on('resize', ...)` listener (mirroring the pattern
 *  `app.tsx`'s `openPager` already uses at open-time: `process.stdout.rows` -> `setState`), which is
 *  exactly what test (c) exercises via `rerender()` with a new prop. */

import React from "react";
import { Box, Text } from "ink";

/** Rows available to the flexGrow content region: root height (`rows - 1`) minus the one row the
 *  pinned BOTTOM line occupies. */
export function shellSpikeContentRows(rows: number): number {
  return Math.max(0, rows - 2);
}

export function ShellSpike({ rows, lines }: { rows: number; lines: string[] }) {
  const available = shellSpikeContentRows(rows);
  const visible = available === 0 ? [] : lines.slice(-available);
  return (
    <Box flexDirection="column" height={rows - 1}>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {visible.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Text>BOTTOM</Text>
    </Box>
  );
}
