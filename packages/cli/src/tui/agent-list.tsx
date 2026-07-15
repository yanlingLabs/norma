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
 *  `.label` resolution note. Pure — no client, no side effects.
 *
 *  Phase 5a Task 3: `agent.name` (a background child's re-taskable handle, mapped by state.ts's
 *  spawn_agent tool_call/tool_result pairing — see `AgentRow`'s own doc comment in state.ts) takes
 *  `.label`'s place in the head row's parenthetical when present, falling back to `.label`
 *  otherwise — a label swap only, the row shape/layout above is unchanged.
 *
 *  Live child-transcript view T3: an optional `selectedIndex` prop (app.tsx's roster select mode)
 *  highlights ONE row — the head gutter swaps to a `▶ ` pointer (a plain-ASCII fingerprint,
 *  independent of ANSI, so tests don't need to parse escape codes) and BOTH of that row's lines
 *  render `inverse` (same reverse-video idiom composer.tsx's cursor cell already uses). Every
 *  other row's layout/gutter is completely unaffected — `undefined` (the default) renders
 *  byte-identical to before this task. */

import React from "react";
import { Box, Text } from "ink";
import type { AgentRow } from "./state";

function pluralizeToolUse(n: number): string {
  return `${n} tool use${n === 1 ? "" : "s"}`;
}

// Roster honesty (no-timeout task, extended by task-16): the terminal verb comes from `finish`
// (the wire's own thread_completed.stopReason, mapped by subagent-state.ts) — "Failed" (a genuine
// provider/tool error), "Stopped" (user abort / task_stop), and "Stalled" (task-16: the
// progress-stall watchdog killed a silent-but-resumable child — its own distinct verb now,
// never folded into "Failed") each render distinctly from a genuine "Done". `finish` absent on a
// terminal row (a pre-change event replay) falls back to "Done", the old wording — never a blank
// continuation.
export const FINISH_LABEL: Record<string, string> = { done: "Done", failed: "Failed", stopped: "Stopped", stalled: "Stalled" };

function AgentTreeRow({ agent, isLast, isSelected }: { agent: AgentRow; isLast: boolean; isSelected: boolean }) {
  const headGutter = isSelected ? "▶  " : isLast ? "└─ " : "├─ ";
  const contGutter = isLast ? "   ⎿  " : "│  ⎿  ";
  const continuation = agent.status === "done"
    ? (FINISH_LABEL[agent.finish ?? "done"] ?? "Done")
    : (agent.activity ?? "Working…");
  return (
    <Box flexDirection="column">
      <Text inverse={isSelected}>
        <Text dimColor={!isSelected}>{headGutter}</Text>
        <Text bold>{agent.agentType}</Text>
        {/* phase 5a T3: a mapped `name` (re-taskable handle) takes the label's place here — same
            slot, same layout; `.label` is the fallback whenever no mapping exists. */}
        {` (${agent.name ?? agent.label})`}
        {` · ${pluralizeToolUse(agent.toolCalls)}`}
      </Text>
      <Text inverse={isSelected} dimColor={!isSelected}>
        {contGutter}
        {continuation}
      </Text>
    </Box>
  );
}

export function AgentList({ agents, nowMs, selectedIndex }: { agents: AgentRow[]; nowMs: number; selectedIndex?: number }) {
  void nowMs;
  if (agents.length === 0) return null;
  return (
    <Box flexDirection="column">
      {agents.map((a, i) => (
        <AgentTreeRow key={a.threadId} agent={a} isLast={i === agents.length - 1} isSelected={i === selectedIndex} />
      ))}
    </Box>
  );
}
