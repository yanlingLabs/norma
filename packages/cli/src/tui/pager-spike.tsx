/** `<PagerSpike>` (phase 3b Task 1 SPIKE) — de-risks the alt-screen mechanism T7 needs for the
 *  ctrl+o full-transcript pager: toggling into a full-screen view without disturbing the
 *  terminal's normal buffer/scrollback underneath. Two views over one seeded 100-line array:
 *    - "normal": a placeholder line standing in for the live app's usual layout.
 *    - "pager": a pure-slice viewport (`lines.slice(offset, offset + rows)`) plus a dim footer,
 *      moved by ↑/↓ (clamped to [0, lines.length - rows]), closed by esc.
 *
 *  ctrl+o (the same chord T7 will bind for real) flips normal → pager, calling `enterAltScreen`
 *  BEFORE the state flip so the escape sequence always precedes the pager's first committed frame;
 *  esc flips pager → normal, calling `leaveAltScreen` before ITS state flip for the same reason.
 *  Both transitions also bump `mountKey` onto the toggled subtree's `key`, forcing Ink/React to
 *  remount (not diff) it so layout is computed fresh against the just-switched buffer rather than
 *  reused from stale state — see the spike report for why this must NOT be applied above any
 *  `<Static>` list (it would reset Static's own internal flush bookkeeping and re-emit history). */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { enterAltScreen, leaveAltScreen } from "./alt-screen";

export const PAGER_FOOTER = "-- transcript · ↑/↓ scroll · esc to close --";

export interface PagerSpikeProps {
  lines: string[];
  rows?: number;
  write: (s: string) => void;
}

export function PagerSpike({ lines, rows = 10, write }: PagerSpikeProps) {
  const [mode, setMode] = useState<"normal" | "pager">("normal");
  const [offset, setOffset] = useState(0);
  const [mountKey, setMountKey] = useState(0);

  const maxOffset = Math.max(0, lines.length - rows);

  useInput((input, key) => {
    if (mode === "normal") {
      if (input === "o" && key.ctrl) {
        enterAltScreen(write); // enter BEFORE the pager frame ever paints
        setMode("pager");
        setOffset(0);
        setMountKey((k) => k + 1);
      }
      return;
    }
    if (key.escape) {
      leaveAltScreen(write); // leave BEFORE the normal frame is restored
      setMode("normal");
      setMountKey((k) => k + 1);
      return;
    }
    if (key.upArrow) {
      setOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }
  });

  if (mode === "normal") {
    return (
      <Box key={`normal-${mountKey}`} flexDirection="column">
        <Text>normal view</Text>
        <Text dimColor>ctrl+o for full transcript</Text>
      </Box>
    );
  }

  const visible = lines.slice(offset, offset + rows);
  return (
    <Box key={`pager-${mountKey}`} flexDirection="column">
      {visible.map((line, i) => (
        <Text key={offset + i}>{line}</Text>
      ))}
      <Text dimColor>{PAGER_FOOTER}</Text>
    </Box>
  );
}
