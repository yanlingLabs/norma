/** `<StatusLine>` (Phase 3a Task 3) — the single-line "turn in progress" indicator: `✳ Working…
 *  <elapsed> · ↑<in> ↓<out>`. Hidden entirely (renders nothing) while `running` is false — this is
 *  transient turn chrome, not part of the committed transcript.
 *
 *  Byte-parity note (per the brief's ambiguity resolution #2): "byte-parity of the committed look"
 *  means the visible GLYPHS/PREFIXES/TEXT match the legacy renderer's intent
 *  (`task-block.ts`'s `renderStatusLine`/`turnSummaryLine` — spinner/activeForm/elapsed/tokens),
 *  not literal ANSI bytes; Ink owns its own coloring (`color="blue"` here) and this component uses
 *  the brief's own inline format string verbatim rather than `renderStatusLine`'s exact spacing —
 *  no `activeForm`/spinner prop exists yet at this layer (that plumbing is a later task), so the
 *  word is always the fixed "Working" for now.
 *
 *  Pure — no client, no `Date.now()`; `nowMs` is the caller's injected clock. */

import React from "react";
import { Text } from "ink";
import { formatElapsed, formatTokens } from "../task-display";

export function StatusLine({
  running,
  turnStartMs,
  inTokens,
  outTokens,
  nowMs,
}: {
  running: boolean;
  turnStartMs?: number;
  inTokens: number;
  outTokens: number;
  nowMs: number;
}) {
  if (!running) return null;
  const elapsed = formatElapsed(nowMs - (turnStartMs ?? nowMs));
  return (
    <Text color="blue">
      ✳ Working… {elapsed} · ↑{formatTokens(inTokens)} ↓{formatTokens(outTokens)}
    </Text>
  );
}
