/** `<ActiveTurn>` (Phase 3b Task 3) — the in-flight (not-yet-committed) portion of the current main
 *  turn: the streaming assistant text (`TuiState.activeAssistant`) plus a one-liner per tool call
 *  that has fired but not yet resolved (`TuiState.activeTools`).
 *
 *  STREAMING MARKDOWN: `splitStableBoundary` (T2, `markdown.ts`) splits the growing text at its last
 *  complete top-level block boundary. The `stable` prefix is rendered through `renderMarkdown` inside
 *  a `React.memo`'d child keyed/memoized purely on the `stable` string — React only re-renders that
 *  child when `stable` itself grows (i.e. a new block boundary is crossed), NOT on every delta, since
 *  most deltas only extend `tail`. `tail` (the still-growing, not-yet-parseable remainder) renders as
 *  plain text — no markdown pass, no dim — one `<Text>` sibling next to the memoized stable child.
 *
 *  STREAMING ASSISTANT GUTTER (T3 review adjudication): the streaming text shares the SAME `⏺`
 *  2-col gutter layout as the committed assistant block (transcript.tsx's pattern — `⏺` in a
 *  `minWidth={2}` gutter colored `theme.text`, stable/tail column in the flexGrow slot). CC renders
 *  in-progress assistant messages through the same bullet layout (its "static" flag only controls
 *  the render freeze, not the layout); omitting the gutter here caused a visible 2-column text jump
 *  + bullet pop-in at every turn's commit. The assistant dot is STEADY (`theme.text`) — blinking
 *  belongs to the in-flight TOOL dot only.
 *
 *  BLINKING TOOL DOT: `Math.floor(nowMs / 500) % 2` flips every 500ms — an even parity dims the `⏺`,
 *  odd leaves it normal. `nowMs` is the caller's injected clock (same discipline as every other Ink
 *  component here): this component has ZERO `Date.now()`/timers of its own.
 *
 *  Hidden entirely (renders nothing) when idle: no streaming text AND no in-flight tools. Pure —
 *  no client, no side effects. */

import React from "react";
import { Box, Text } from "ink";
import { renderMarkdown, splitStableBoundary } from "./markdown";
import { theme } from "./theme";
import { formatArgsHead } from "./format";

/** Memoized so the (potentially expensive, re-lexed-on-every-boundary-advance) markdown render of
 *  the STABLE prefix only re-runs when `stable` itself changes — not on every streaming delta, which
 *  typically only grows the separately-rendered `tail`. */
const StableAssistantText = React.memo(function StableAssistantText({ stable }: { stable: string }) {
  return <Text>{renderMarkdown(stable)}</Text>;
});

export function ActiveTurn({
  assistant,
  tools,
  nowMs = 0,
}: {
  assistant: string;
  tools: { name: string; argsJson: string }[];
  nowMs?: number;
}) {
  if (!assistant && tools.length === 0) return null;
  const { stable, tail } = splitStableBoundary(assistant);
  // Even parity (0, 2, 4, ... half-second ticks) dims the dot; odd parity is normal — the exact
  // phase doesn't matter (Step 1(h) only requires the two states to DIFFER 500ms apart and repeat
  // every 1000ms), just that it is a pure function of nowMs alone.
  const dimTool = Math.floor(nowMs / 500) % 2 === 0;

  return (
    <Box flexDirection="column">
      {assistant ? (
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color={theme.text}>⏺</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {stable ? <StableAssistantText stable={stable} /> : null}
            {tail ? <Text>{tail}</Text> : null}
          </Box>
        </Box>
      ) : null}
      {tools.map((t, i) => {
        const argsHead = formatArgsHead(t.argsJson);
        return (
          <Box key={i} flexDirection="row">
            <Box minWidth={2}>
              <Text dimColor={dimTool}>⏺</Text>
            </Box>
            <Box flexGrow={1}>
              <Text>
                <Text bold>{t.name}</Text>
                {argsHead ? <Text>({argsHead})</Text> : null}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
