/** `<Pager>` (Phase 3b Task 7) — the ctrl+o full-transcript pager: a VERBOSE, scrollable rendering
 *  of the committed transcript (`TuiState.committed`) shown on the terminal's ALTERNATE screen
 *  buffer while it is open. "Verbose" means the opposite of the pinned transcript's compaction:
 *   - `groupBlocks` is NOT applied — every read/search/list tool shows as its own line (the collapse
 *     summary "Read N files" only exists in the live pinned view; the pager is where you go to see
 *     the underlying individual calls).
 *   - tool outputs are shown IN FULL — no 10-line cap, no "… +N lines (ctrl+o to expand)" hint (this
 *     IS the ctrl+o expansion).
 *
 *  Two layers, both pure and independently testable:
 *   - `pagerLines(blocks)` flattens the whole transcript to plain text LINES (no ANSI, no Ink) — the
 *     unit of scrolling. Kept plain so the window math and the tests reason over strings.
 *   - `pagerViewport(lines, rows, offset)` clamps `offset` and slices the visible window.
 *
 *  HARD CONSTRAINT 1 (scrollback safety): Ink emits `ansiEscapes.clearTerminal`
 *  (`\x1b[2J\x1b[3J\x1b[H` — the `3J` ERASES SCROLLBACK) whenever a frame's dynamic `outputHeight`
 *  reaches `stdout.rows` (verified in ink@5.2.1 `ink.js`/`renderer.js`: `outputHeight` counts the
 *  NON-static region only). The pager is a sibling of the (still-mounted) `<CommittedTranscript>`,
 *  whose Static content is excluded from `outputHeight` but whose one possible dynamic "open tail"
 *  line is NOT — so `pagerWindowRows` reserves THREE lines off the terminal height: one for the
 *  pager's own footer, one for that open-tail sibling, and one for the strict `<` (Ink trips at
 *  `>=`). Total dynamic output while the pager is open is therefore `<= rows - 1 < rows`. */

import React from "react";
import { Box, Text } from "ink";
import type { Block } from "./state";
import { formatArgsHead } from "./transcript";
import { pickVerb, TURN_VERBS } from "./spinner-verbs";
import { formatElapsed, formatTokens } from "../task-display";

/** The dim footer beneath the viewport — mirrors the T1 spike's hint, widened to advertise BOTH
 *  close chords (esc and a second ctrl+o) since the App binds both. */
export const PAGER_FOOTER = "-- transcript · ↑/↓ scroll · esc/ctrl+o to close --";

/** First line carries `prefix`; any wrapped/continuation lines of a multi-line block text follow
 *  unprefixed. An empty text still yields one prefixed line (the glyph alone). */
function prefixed(prefix: string, text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

/** One committed `Block` → its plain-text pager lines (verbose: full output, no grouping). */
function blockLines(block: Block): string[] {
  switch (block.kind) {
    case "user":
      return prefixed("❯ ", block.text);
    case "assistant":
      return prefixed("⏺ ", block.text);
    case "tool": {
      const argsHead = formatArgsHead(block.argsJson);
      const head = `⏺ ${block.name}${argsHead ? `(${argsHead})` : ""}`;
      const output = block.output ?? "";
      if (output.length === 0) return [head];
      const outLines = output.split("\n");
      // Full output — the `⎿` gutter on the first line, aligned padding under it, NO truncation.
      return [head, ...outLines.map((line, i) => (i === 0 ? `  ⎿  ${line}` : `     ${line}`))];
    }
    case "skill":
      return [`✻ Skill: ${block.name}`];
    case "note":
      return prefixed("✻ ", block.text);
    case "turn-summary": {
      const verb = pickVerb(TURN_VERBS, block.durationMs);
      return [`✻ ${verb} for ${formatElapsed(block.durationMs)} · ↑${formatTokens(block.inTokens)} ↓${formatTokens(block.outTokens)} tokens`];
    }
    case "interrupted":
      return ["  ⎿  Interrupted · What should Norma do instead?"];
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/** Flatten the whole committed transcript to plain text lines — the scroll unit. Pure. */
export function pagerLines(blocks: Block[]): string[] {
  return blocks.flatMap(blockLines);
}

/** Content rows the viewport may show given the terminal height (see HARD CONSTRAINT 1 above):
 *  reserve the footer row + one open-tail sibling line + one strict-`<` line = 3. Floored at 1. */
export function pagerWindowRows(rows: number): number {
  return Math.max(1, rows - 3);
}

/** Clamp `offset` into `[0, lines.length - windowRows]` and slice the visible window. Returns the
 *  clamped offset too, so the caller (App) can keep its own scroll state in bounds. Pure. */
export function pagerViewport(lines: string[], rows: number, offset: number): { window: string[]; offset: number } {
  const windowRows = pagerWindowRows(rows);
  const maxOffset = Math.max(0, lines.length - windowRows);
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  return { window: lines.slice(clamped, clamped + windowRows), offset: clamped };
}

export function Pager({ blocks, rows, offset }: { blocks: Block[]; rows: number; offset: number }) {
  const { window } = pagerViewport(pagerLines(blocks), rows, offset);
  return (
    <Box flexDirection="column">
      {window.map((line, i) => (
        // A blank source line renders as a single space so Ink keeps the row (empty <Text> collapses).
        <Text key={i}>{line.length > 0 ? line : " "}</Text>
      ))}
      <Text dimColor>{PAGER_FOOTER}</Text>
    </Box>
  );
}
