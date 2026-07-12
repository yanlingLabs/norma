/** `<CommittedTranscript>` (Phase 3a Task 3) — renders `TuiState.committed` (`Block[]`) inside an
 *  Ink `<Static>` (committed lines are painted ONCE and never re-rendered, matching the spike's
 *  proven Static+dynamic-region split). Pure presentational: no client, no side effects.
 *
 *  Byte-parity source of truth is `main.ts`'s interactive stream branches (packages/cli/src/main.ts
 *  ~493-556) plus `task-block.ts` — this component MIRRORS those glyphs/prefixes/truncation
 *  (tool_call's `argsJson.slice(0, 120)`, tool_result's first-line-only + `.slice(0, 120)` + an
 *  "ERROR: " prefix outside that slice) rather than reimplementing the formatting rules elsewhere. */

import React from "react";
import { Box, Static, Text } from "ink";
import type { Block } from "./state";

const ARGS_HEAD_LEN = 120; // same 120-char head main.ts's tool_call branch slices to today
const OUTPUT_HEAD_LEN = 120; // same 120-char head main.ts's tool_result branch slices to today

function TranscriptEntry({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return <Text>{"› "}{block.text}</Text>;
    case "assistant":
      return <Text color="cyan">{block.text}</Text>;
    case "tool": {
      const argsHead = block.argsJson.slice(0, ARGS_HEAD_LEN);
      const outputHead = (block.output ?? "").split("\n")[0]?.slice(0, OUTPUT_HEAD_LEN) ?? "";
      return (
        <Text dimColor>
          {"⚙ "}{block.name} {argsHead} ▸ {block.isError ? "ERROR: " : ""}{outputHead}
        </Text>
      );
    }
    case "skill":
      return <Text dimColor>⚙ Skill: {block.name}</Text>;
    case "note":
      return <Text dimColor>{block.text}</Text>;
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
