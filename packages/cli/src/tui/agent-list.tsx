/** `<AgentList>` (Phase 3b Task 6) — the live-region subagent roster (`TuiState.agents`, `AgentRow`
 *  = `CliSubagent`), rewritten from 3a's single-line-per-agent panel into CC's git-log-graph TREE
 *  rows (`cc-ui-study-transcript.md` §4, `AgentProgressLine.tsx`, adapted not copied): a head row
 *  per agent —
 *
 *    ├─ <bold agentType> (<label>) · N tool use(s)      (not the last agent, dim gutter)
 *    └─ <bold agentType> (<label>) · N tool use(s)      (the LAST agent, dim gutter)
 *
 *  — followed by a dim continuation row reusing the `⎿` glyph:
 *
 *    │  ⎿  <activity, or "Working…" if none yet>        (not last, still not done)
 *       ⎿  Done                                          (last, done)
 *
 *  The component's prop shape (`{ agents: AgentRow[]; nowMs: number }`) is UNCHANGED from 3a so
 *  `app.tsx` (which still renders `<AgentList agents={state.agents} nowMs={nowMs} />` verbatim)
 *  keeps compiling without modification. `nowMs` is accepted but unused here — this tree view shows
 *  no per-row elapsed time (that now only appears once, in state.ts's `Done (...)` finish note).
 *
 *  Deliberately does NOT reuse `subagent-display.ts`'s `subagentGlyph`/`subagentElapsedMs` (that
 *  file stays Swift-lockstep and READ-only from here) — the tree layout has no room for a
 *  per-status glyph column, and elapsed time moved to the finish note. `.activity` (already
 *  computed onto the row by `subagent-state.ts`'s `tool_call` case via `extractToolDetail`) is read
 *  directly, same "row already carries the derived field, don't re-derive it" discipline as 3a's
 *  `.label` resolution note. Pure — no client, no side effects. */

import React from "react";
import { Box, Text } from "ink";
import type { AgentRow } from "./state";

function pluralizeToolUse(n: number): string {
  return `${n} tool use${n === 1 ? "" : "s"}`;
}

function AgentTreeRow({ agent, isLast }: { agent: AgentRow; isLast: boolean }) {
  const headGutter = isLast ? "└─ " : "├─ ";
  const contGutter = isLast ? "   ⎿  " : "│  ⎿  ";
  const continuation = agent.status === "done" ? "Done" : (agent.activity ?? "Working…");
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{headGutter}</Text>
        <Text bold>{agent.agentType}</Text>
        {` (${agent.label})`}
        {` · ${pluralizeToolUse(agent.toolCalls)}`}
      </Text>
      <Text dimColor>
        {contGutter}
        {continuation}
      </Text>
    </Box>
  );
}

export function AgentList({ agents, nowMs }: { agents: AgentRow[]; nowMs: number }) {
  void nowMs;
  if (agents.length === 0) return null;
  return (
    <Box flexDirection="column">
      {agents.map((a, i) => (
        <AgentTreeRow key={a.threadId} agent={a} isLast={i === agents.length - 1} />
      ))}
    </Box>
  );
}
