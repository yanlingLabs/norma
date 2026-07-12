/** `<ActiveTurn>` (Phase 3a Task 3) — the in-flight (not-yet-committed) portion of the current main
 *  turn: the streaming assistant text (`TuiState.activeAssistant`) plus a dim one-liner per tool
 *  call that has fired but not yet resolved (`TuiState.activeTools`). Mirrors main.ts's tool_call
 *  one-liner (`⚙ name args-head`, same 120-char head) — no output yet, since that only exists once
 *  `tool_result` lands and the pair becomes a committed `Block` (transcript.tsx). Collapsing a long
 *  assistant stream / markdown rendering is Phase 3b, not this task.
 *
 *  Hidden entirely (renders nothing) when idle: no streaming text AND no in-flight tools. Pure —
 *  no client, no side effects. */

import React from "react";
import { Box, Text } from "ink";

const ARGS_HEAD_LEN = 120; // same 120-char head main.ts's tool_call branch slices to today

export function ActiveTurn({ assistant, tools }: { assistant: string; tools: { name: string; argsJson: string }[] }) {
  if (!assistant && tools.length === 0) return null;
  return (
    <Box flexDirection="column">
      {assistant ? <Text color="cyan">{assistant}</Text> : null}
      {tools.map((t, i) => (
        <Text key={i} dimColor>
          {"⚙ "}{t.name} {t.argsJson.slice(0, ARGS_HEAD_LEN)}
        </Text>
      ))}
    </Box>
  );
}
