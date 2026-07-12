/** `<CommittedTranscript>` (Phase 3b Task 3) — renders `TuiState.committed` (`Block[]`) inside an
 *  Ink `<Static>` (committed lines are painted ONCE and never re-rendered) using the Claude-Code
 *  transcript grammar (binding reference: `.superpowers/sdd/cc-ui-study-transcript.md` §2, ADAPTED
 *  not copied — see that file's header for the leak-derivation/citation policy): every assistant
 *  action is a `⏺`-gutter line, tool results hang a dim `  ⎿  `-gutter continuation underneath, user
 *  turns get a `❯ ` pointer, and system one-liners (notes/turn-summary/interrupted) get a dim `✻ `
 *  (or the `⎿` continuation glyph for "interrupted", since it always follows the turn it belongs to).
 *
 *  INK CONSTRAINT NOTE: Ink 5's `<Box>` has no `backgroundColor` prop (only `<Text>` does — see
 *  `node_modules/ink/build/styles.d.ts`); the study's "solid full-width highlight block" for user
 *  messages is therefore approximated here as `backgroundColor` on the `<Text>` node itself (covers
 *  the rendered text, not the full terminal width) — the closest available fit under Ink's real
 *  layout model, not a literal recreation of a custom-renderer-only effect.
 *
 *  AMBIGUITY RESOLUTION (task brief's Key Semantics section, tool RESULT gutter): the literal
 *  `"  ⎿  "` (two spaces + glyph + two spaces) is rendered ONCE per result block, in a fixed-width
 *  gutter Box to the left of a `flexGrow` column holding all shown output lines — this is what makes
 *  every subsequent (wrapped/continuation) line indent under the glyph rather than repeat it, per
 *  the study's `MessageResponse.tsx` note (§2, "Nested MessageResponses suppress the second ⎿").
 *
 *  Pure presentational: no client, no side effects. */

import React from "react";
import { Box, Static, Text } from "ink";
import type { Block } from "./state";
import { theme } from "./theme";
import { renderMarkdown, type Highlighter } from "./markdown";
import { pickVerb, TURN_VERBS } from "./spinner-verbs";
import { formatElapsed, formatTokens } from "../task-display";
import { groupBlocks, type DisplayItem } from "./group-blocks";

/** Same 2-line/160-char args-head cap the tool USE line and ActiveTurn's in-flight tool line both
 *  use (widened from 3a's 120-char single-line cap per the brief) — kept RAW (no re-serialization
 *  of the argsJson), matching 3a's "slice the raw string" approach, just with the wider cap. A
 *  trailing `…` marks truncation (either cap), per the study's documented "trimmed + …" behavior;
 *  an args string already within both caps passes through unchanged. */
const ARGS_HEAD_CHARS = 160;
const ARGS_HEAD_LINES = 2;

/** Result-line cap (both tool blocks and, structurally, anything else that grows a `⎿` body):
 *  counts LINES (split on "\n"), not characters — a single very-long line is NOT itself truncated
 *  here (that's a terminal-wrap concern Ink already owns), only the LINE COUNT is capped. */
const MAX_RESULT_LINES = 10;

export function formatArgsHead(argsJson: string): string {
  const lines = argsJson.split("\n");
  let head = lines.slice(0, ARGS_HEAD_LINES).join("\n");
  let truncated = lines.length > ARGS_HEAD_LINES;
  if (head.length > ARGS_HEAD_CHARS) {
    head = head.slice(0, ARGS_HEAD_CHARS);
    truncated = true;
  }
  return truncated ? `${head}…` : head;
}

function ToolResult({ output, isError }: { output: string; isError?: boolean }) {
  if (output.length === 0) return null;
  const lines = output.split("\n");
  const shown = lines.slice(0, MAX_RESULT_LINES);
  const hiddenCount = lines.length - shown.length;
  return (
    <Box flexDirection="row">
      <Box minWidth={5}>
        <Text dimColor>{"  ⎿  "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {shown.map((line, i) => (
          <Text key={i} color={isError ? theme.error : undefined}>
            {line}
          </Text>
        ))}
        {hiddenCount > 0 ? <Text dimColor>{`… +${hiddenCount} lines (ctrl+o to expand)`}</Text> : null}
      </Box>
    </Box>
  );
}

function TranscriptEntry({ block, highlight }: { block: Block; highlight?: Highlighter }) {
  switch (block.kind) {
    case "user":
      return (
        <Box>
          <Text backgroundColor={theme.userMessageBackground}>
            {"❯ "}
            {block.text}
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color={theme.text}>⏺</Text>
          </Box>
          <Box flexGrow={1}>
            <Text>{renderMarkdown(block.text, highlight)}</Text>
          </Box>
        </Box>
      );

    case "tool": {
      const argsHead = formatArgsHead(block.argsJson);
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color={block.isError ? theme.error : theme.success}>⏺</Text>
            </Box>
            <Box flexGrow={1}>
              <Text>
                <Text bold>{block.name}</Text>
                {argsHead ? <Text>({argsHead})</Text> : null}
              </Text>
            </Box>
          </Box>
          <ToolResult output={block.output ?? ""} isError={block.isError} />
        </Box>
      );
    }

    case "skill":
      return (
        <Text dimColor>
          {"✻ Skill: "}
          {block.name}
        </Text>
      );

    case "note":
      return (
        <Text dimColor>
          {"✻ "}
          {block.text}
        </Text>
      );

    case "turn-summary": {
      const verb = pickVerb(TURN_VERBS, block.durationMs);
      return (
        <Text dimColor>
          {"✻ "}
          {verb} for {formatElapsed(block.durationMs)} · ↑{formatTokens(block.inTokens)} ↓{formatTokens(block.outTokens)}{" "}
          tokens
        </Text>
      );
    }

    case "interrupted":
      return <Text dimColor>{"  ⎿  Interrupted · What should Norma do instead?"}</Text>;

    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/** A collapsed run renders as ONE dim `⏺`-gutter line: the summary text plus a dim
 *  " (ctrl+o to expand)" hint (brief's Task 4 wiring instruction) — same gutter layout as the
 *  assistant/tool cases above, just uncolored (dim) since no single tool's success/error state
 *  applies to the run as a whole. */
function CollapsedEntry({ summary }: { summary: string }) {
  return (
    <Box flexDirection="row">
      <Box minWidth={2}>
        <Text dimColor>⏺</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor>
          {summary}
          {" (ctrl+o to expand)"}
        </Text>
      </Box>
    </Box>
  );
}

function DisplayEntry({ item, highlight }: { item: DisplayItem; highlight?: Highlighter }) {
  return item.kind === "collapsed" ? <CollapsedEntry summary={item.summary} /> : <TranscriptEntry block={item.block} highlight={highlight} />;
}

/** A synthetic leading Static entry (the welcome banner, Phase 3b Task 7) sits alongside the real
 *  transcript items so it lands ONCE at the top of scrollback — Ink supports a single `<Static>` per
 *  tree, so the header can't be a separate sibling Static; it rides as the first element of this
 *  Static's items array instead, past which the flush pointer never returns. */
type StaticItem = { kind: "header"; node: React.ReactNode } | DisplayItem;

export function CommittedTranscript({ items, header, highlight }: { items: Block[]; header?: React.ReactNode; highlight?: Highlighter }) {
  // Ink's <Static> (build/components/Static.js) paints whatever it renders on a pass PERMANENTLY —
  // later renders only ever render the NEW tail past the previous items.length, and never revisit
  // an index it already painted. groupBlocks(items) is NOT safe to feed it directly: a still-open
  // run at the END of `items` can absorb a newly-committed sibling block without the DisplayItem[]
  // array growing (two reads collapse into the SAME one collapsed item, not a new one), so Static
  // would silently skip repainting it and the on-screen summary would freeze at a stale, undercounted
  // wording (e.g. stuck at "Read 1 file" forever once a second read/grep actually arrives).
  //
  // Fix: only ever hand Static a PREFIX of DisplayItem[] that can never again change — i.e. every
  // group already closed by a later, non-matching block. The trailing run, if `items` still ends
  // on a collapsible tool block (so a future sibling could still extend it), is rendered in a
  // plain (always-freshly-recomputed) Box below Static instead — exactly the same "committed vs.
  // still-live" split already used between this component and <ActiveTurn> in app.tsx, just nested
  // one level deeper. The moment a breaking block arrives, that whole run becomes closed and moves
  // into the Static-safe prefix on the very next render, where it can never change again.
  const displayItems = groupBlocks(items);
  const tailIsOpenRun = displayItems.length > 0 && displayItems[displayItems.length - 1]!.kind === "collapsed";
  const settled = tailIsOpenRun ? displayItems.slice(0, -1) : displayItems;
  const openTail = tailIsOpenRun ? displayItems[displayItems.length - 1]! : null;

  const staticItems: StaticItem[] = header != null ? [{ kind: "header", node: header }, ...settled] : settled;

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item, i) => (
          <Box key={i}>
            {item.kind === "header" ? item.node : <DisplayEntry item={item} highlight={highlight} />}
          </Box>
        )}
      </Static>
      {openTail ? (
        <Box>
          <DisplayEntry item={openTail} highlight={highlight} />
        </Box>
      ) : null}
    </Box>
  );
}
