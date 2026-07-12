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
import { renderMarkdown } from "./markdown";
import { pickVerb, TURN_VERBS } from "./spinner-verbs";
import { formatElapsed, formatTokens } from "../task-display";

/** Same 2-line/160-char args-head cap the tool USE line and ActiveTurn's in-flight tool line both
 *  use (widened from 3a's 120-char single-line cap per the brief) — kept RAW (no re-serialization
 *  of the argsJson), matching 3a's "slice the raw string" approach, just with the wider cap. */
const ARGS_HEAD_CHARS = 160;
const ARGS_HEAD_LINES = 2;

/** Result-line cap (both tool blocks and, structurally, anything else that grows a `⎿` body):
 *  counts LINES (split on "\n"), not characters — a single very-long line is NOT itself truncated
 *  here (that's a terminal-wrap concern Ink already owns), only the LINE COUNT is capped. */
const MAX_RESULT_LINES = 10;

export function formatArgsHead(argsJson: string): string {
  const headLines = argsJson.split("\n").slice(0, ARGS_HEAD_LINES).join("\n");
  return headLines.slice(0, ARGS_HEAD_CHARS);
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

function TranscriptEntry({ block }: { block: Block }) {
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
            <Text>{renderMarkdown(block.text)}</Text>
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

export function CommittedTranscript({ items }: { items: Block[] }) {
  return (
    <Static items={items}>
      {(block, i) => (
        <Box key={i}>
          <TranscriptEntry block={block} />
        </Box>
      )}
    </Static>
  );
}
