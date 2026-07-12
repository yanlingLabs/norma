/** `<AgentList>` (Phase 3a Task 3) — the subagent roster (`TuiState.agents`, `AgentRow` =
 *  `CliSubagent`), one row per entry: `{glyph} Agent(label) agentType · N tools · elapsed[ ·
 *  tokens]`. Hidden entirely when there are no agents.
 *
 *  Ambiguity resolution #1 (per the task brief): renders the row's `.label` DIRECTLY — it is
 *  already the resolved label `subagent-state.ts` computed via `subagentLabel` at `thread_started`
 *  time and persisted onto the row; this component must NOT re-derive it (the row carries no raw
 *  description/prompt to feed `subagentLabel` with). This is also where THE BUG FIX (state.ts's
 *  header) becomes visible: a DONE child thread's row is never wiped by a main-thread
 *  `turn_completed`, so its real label/stats render here instead of an empty/`0s` placeholder.
 *
 *  Reuses `subagent-display.ts`'s pure helpers (`subagentGlyph`, `subagentTokens`,
 *  `subagentElapsedMs`) rather than re-deriving glyph/token/elapsed formatting. Pure — no client,
 *  no side effects; `nowMs` is the caller's injected clock (only matters for a still-`"working"`
 *  row's open span — `subagentElapsedMs` reads `activeMs` alone for a `"done"` row). */

import React from "react";
import { Box, Text } from "ink";
import type { AgentRow } from "./state";
import { formatElapsed } from "../task-display";
import { subagentElapsedMs, subagentGlyph, subagentTokens } from "../subagent-display";

export function AgentList({ agents, nowMs }: { agents: AgentRow[]; nowMs: number }) {
  if (agents.length === 0) return null;
  return (
    <Box flexDirection="column">
      {agents.map((a) => {
        const elapsed = formatElapsed(subagentElapsedMs(a, nowMs));
        const tokens = subagentTokens(a.inputTokens, a.outputTokens, a.liveOutputChars);
        return (
          <Text key={a.threadId}>
            {subagentGlyph(a.status)} Agent({a.label}) {a.agentType} · {a.toolCalls} tools · {elapsed}
            {tokens ? ` · ${tokens}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}
