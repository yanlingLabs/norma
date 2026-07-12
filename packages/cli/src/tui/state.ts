/** Pure app-state reducer for the Ink TUI (Phase 3a Task 2) — THE HEART: composes Norma's existing
 *  tested reducers (`subagent-state.ts`'s `updateSubagents`, `task-block.ts`'s `upsertTask`) into
 *  ONE `TuiState` that every Ink component (Tasks 3-6) renders from. Every wire event in main.ts's
 *  interactive switch (packages/cli/src/main.ts:493-680) has an equivalent transition here.
 *
 *  Note-block wording is matched to main.ts's plain-text CONTENT (glyphs/words), MINUS the
 *  embedded ANSI escapes main.ts's `emit()` bakes in — `Block`'s fields are presentation-agnostic
 *  data; coloring a note/tool/assistant block is the Ink components' job (Tasks 3-6), not this
 *  reducer's. `approval_resolved`'s note (main.ts never prints one today — raw-mode there just
 *  lets the "y/N" keystroke reach cooked stdin) is new: Ink owns the whole render surface via
 *  `useInput`, so an answered approval needs an explicit committed record or it would otherwise
 *  vanish with no trace once `pending` clears.
 *
 *  THE BUG FIX (`Agent "" · 0s`, main.ts:637-649): main.ts's `updateSubagents` prunes the WHOLE
 *  subagent list to `[]` on the MAIN thread's own `turn_completed`
 *  (`subagent-state.ts`'s `case "turn_completed": if (threadId === "main") return items.length ? []
 *  : items`) — a `run_in_background` child that finishes AFTER the main turn already lost its
 *  label/stats by the time its `thread_completed` arrives (`item` is `undefined`, so main.ts falls
 *  back to the bare threadId/0). This reducer NEVER feeds a MAIN-thread `turn_completed` (or
 *  `agent_error`) into `updateSubagents` — those are the only two cases that prune — so `agents`
 *  here is never wiped wholesale; a finished child's row survives (marked `"done"`) until its OWN
 *  `thread_completed` commits its finish note, reading stats from that still-live row (which, by
 *  construction, can never be undefined here).
 *
 *  PURE: `nowMs` is the caller's injected clock (App.tsx will tick it); `reduce` itself never calls
 *  `Date.now()`. ZERO Ink/React import — unit-testable in isolation (state.test.ts). */

import type { Task } from "@norma/protocol";
import { updateSubagents, type CliSubagent } from "../subagent-state";
import { upsertTask } from "../task-block";
import { formatElapsed, type TaskRow } from "../task-display";

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; argsJson: string; output?: string; isError?: boolean }
  | { kind: "skill"; name: string } // reserved: no current wire event drives this (future skill-detection)
  | { kind: "note"; text: string } // dir-added / worktree / bg-task / agent-finish / approval-resolved one-liners
  | { kind: "turn-summary"; durationMs: number; inTokens: number; outTokens: number } // main turn_completed, stopReason !== "aborted"
  | { kind: "interrupted" }; // main turn_completed, stopReason === "aborted"

/** `AgentRow` IS `CliSubagent`-shaped (the brief's interface matches it field-for-field) — reuse the
 *  type directly rather than re-declaring an equivalent interface that could drift out of lockstep. */
export type AgentRow = CliSubagent;

export type PendingCard =
  | { kind: "approval"; callId: string; toolName: string; summary: string }
  | { kind: "question"; callId: string; questions: unknown[] }
  | { kind: "plan"; callId: string; plan: string };

export interface TuiState {
  committed: Block[]; // → <Static> (Task 3)
  activeAssistant: string; // streaming text of the in-flight assistant message
  activeTools: { name: string; argsJson: string }[]; // tool_calls emitted this turn not yet resulted
  tasks: TaskRow[]; // raw upserted list; sort/collapse is the component's job (task-display.ts)
  agents: AgentRow[]; // CliSubagent-shaped; NEVER pruned wholesale on the main turn_completed
  turnRunning: boolean;
  turnStartMs?: number;
  inTokens: number;
  outTokens: number;
  pending: PendingCard | null;
}

const MAIN = "main";

export function initialState(): TuiState {
  return {
    committed: [],
    activeAssistant: "",
    activeTools: [],
    tasks: [],
    agents: [],
    turnRunning: false,
    inTokens: 0,
    outTokens: 0,
    pending: null,
  };
}

/** Loosely-typed incoming wire event — mirrors `SessionEvent` (protocol/events.ts) but `reduce`
 *  reads fields defensively (same discipline as `subagent-state.ts`'s `WireEvent`) since a caller
 *  may feed it any object shaped like an event (tests, replay, a future transport variant). */
type WireEvent = { type: string; threadId?: string; [k: string]: unknown };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

/** Feeds ONE event into `updateSubagents` and returns the possibly-updated `agents` array — the
 *  single call site every child-thread branch below shares, so the "which events reach
 *  updateSubagents" decision lives in exactly one place. Deliberately NEVER called for a
 *  MAIN-thread `turn_completed` or for `agent_error` — subagent-state.ts prunes the whole list to
 *  `[]` for those two cases (see the file header), which is exactly the bug this reducer fixes. */
function feedAgents(s: TuiState, e: WireEvent): TuiState {
  const next = updateSubagents(s.agents, e);
  return next === s.agents ? s : { ...s, agents: next };
}

export function reduce(s: TuiState, e: WireEvent, nowMs: number): TuiState {
  switch (e.type) {
    case "user_message":
      return { ...s, committed: [...s.committed, { kind: "user", text: str(e.text) }] };

    case "assistant_delta": {
      if (e.threadId !== MAIN) return feedAgents(s, e); // child deltas: track liveOutputChars only
      return { ...s, activeAssistant: s.activeAssistant + str(e.delta) };
    }

    case "assistant_message": {
      if (e.threadId !== MAIN) return s; // children run to completion inside the main tool loop —
      // their assistant_message never needs a separate committed block; the finish note (below)
      // is what makes a child's work permanent, matching main.ts's own main-only handling.
      return {
        ...s,
        committed: [...s.committed, { kind: "assistant", text: str(e.text) }],
        activeAssistant: "",
      };
    }

    case "tool_call": {
      if (e.threadId !== MAIN) return feedAgents(s, e); // child tool calls: just bump toolCalls/activity
      return { ...s, activeTools: [...s.activeTools, { name: str(e.name), argsJson: str(e.argsJson) }] };
    }

    case "tool_result": {
      if (e.threadId !== MAIN) return s; // child tool_result has no wire event of its own to feed here
      // Main-thread tool_call/tool_result always alternate one at a time — the engine's dispatch
      // loop (packages/core/src/agent/engine.ts's `for (const call of calls)`) emits tool_call,
      // awaits execution, THEN emits that SAME call's tool_result before ever emitting the next
      // tool_call — so activeTools holds at most one entry for "main" and this call is always the
      // one it pairs with; no callId needs to ride the (call-id-less) activeTools/Block shapes.
      const call = s.activeTools[0];
      return {
        ...s,
        activeTools: s.activeTools.slice(1),
        committed: [...s.committed, {
          kind: "tool",
          name: call?.name ?? "",
          argsJson: call?.argsJson ?? "",
          output: str(e.output),
          isError: e.isError === true,
        }],
      };
    }

    case "turn_started": {
      if (e.threadId !== MAIN) return feedAgents(s, e);
      // Drop finished subagents from the live roster at the next main turn. Their named finish notes are
      // already committed on thread_completed, so nothing is lost — this keeps the don't-prune-on-
      // turn_completed guard (the `Agent "" · 0s` fix) intact while bounding the pinned live region's
      // height, so a long agent-heavy session can't grow <AgentList> past the terminal and re-hide the
      // composer (whole-branch review, Important). Restores legacy's per-turn roster clear cadence.
      const agents = s.agents.some((a) => a.status === "done") ? s.agents.filter((a) => a.status !== "done") : s.agents;
      return { ...s, turnRunning: true, turnStartMs: nowMs, agents };
    }

    case "turn_completed": {
      // MAIN-thread only — and critically NEVER routed through updateSubagents (see file header):
      // that is the one-line fix for the `Agent "" · 0s` bug.
      if (e.threadId !== MAIN) return feedAgents(s, e);
      const inTokens = num(e.inputTokens);
      const outTokens = num(e.outputTokens);
      // Commits exactly ONE transcript-visible marker for the just-finished main turn: an
      // "interrupted" block when the user cancelled it (stopReason "aborted"), otherwise a
      // "turn-summary" block carrying the real elapsed span (nowMs - turnStartMs; 0 if a
      // turn_completed somehow arrives with no matching turn_started) + the token counts. Phase
      // 3b Task 3 — rendering (verb/glyph/wording) lives in transcript.tsx, not here.
      const block: Block =
        e.stopReason === "aborted"
          ? { kind: "interrupted" }
          : { kind: "turn-summary", durationMs: s.turnStartMs !== undefined ? nowMs - s.turnStartMs : 0, inTokens, outTokens };
      return { ...s, turnRunning: false, inTokens, outTokens, committed: [...s.committed, block] };
    }

    case "thread_started":
      return feedAgents(s, e);

    case "thread_completed": {
      // Feed updateSubagents FIRST so `row` below reads the fully-closed span (banked activeMs) —
      // matches main.ts:646's `subagents.find(...)` which also reads AFTER that event's own
      // reassignment. Never pruned to [] regardless of arrival order relative to the main turn's
      // own turn_completed (that guard lives in the `turn_completed` case above), so `row` is never
      // undefined here — this reducer's whole point.
      const withDone = feedAgents(s, e);
      const row = withDone.agents.find((a) => a.threadId === e.threadId);
      const label = row?.label ?? str(e.threadId);
      const lines = [`Agent "${label}" finished · ${formatElapsed(row?.activeMs ?? 0)}`];
      if ((row?.toolCalls ?? 0) > 0) lines.push(`⎿ Ran ${row!.toolCalls} tool calls`);
      return { ...withDone, committed: [...withDone.committed, { kind: "note", text: lines.join("\n") }] };
    }

    case "task_updated":
      return { ...s, tasks: upsertTask(s.tasks as Task[], e.task as Task) };

    case "approval_requested":
      return { ...s, pending: { kind: "approval", callId: str(e.callId), toolName: str(e.toolName), summary: str(e.summary) } };

    case "approval_resolved": {
      const pending = s.pending;
      const toolName = pending?.kind === "approval" && pending.callId === e.callId ? pending.toolName : str(e.callId);
      const text = `${e.approved ? "approved" : "denied"} ${toolName}`;
      return { ...s, pending: null, committed: [...s.committed, { kind: "note", text }] };
    }

    case "question_asked":
      return { ...s, pending: { kind: "question", callId: str(e.callId), questions: (e.questions as unknown[]) ?? [] } };

    case "question_resolved": {
      // Symmetric to approval_resolved/plan_resolved: the resolution event — also fired when another
      // attached client answers or the QuestionBroker times out — clears the pending card and leaves a
      // transcript trace of the answers. main.ts renders no dedicated question_resolved line (its
      // cooked-stdin echo of the typed answers served that role); in the Ink model the card lived in
      // the live region, so a committed note is the only surviving trace. Empty answers (timeout /
      // resolved elsewhere with no payload) → clear pending, commit nothing.
      const answers = (e.answers ?? {}) as Record<string, string>;
      const notes = Object.entries(answers).map(([q, a]) => ({ kind: "note" as const, text: `${q}: ${a}` }));
      return { ...s, pending: null, committed: [...s.committed, ...notes] };
    }

    case "plan_presented":
      return { ...s, pending: { kind: "plan", callId: str(e.callId), plan: str(e.plan) } };

    case "plan_resolved": {
      // Same wording as main.ts:618 (minus ANSI): "plan approved[ (auto-accept edits)]" / "plan rejected".
      const text = e.approved ? `plan approved${e.autoAccept ? " (auto-accept edits)" : ""}` : "plan rejected";
      return { ...s, pending: null, committed: [...s.committed, { kind: "note", text }] };
    }

    case "directory_added": {
      const text = `+ dir ${str(e.path)}${e.persisted ? " (remembered)" : ""}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "bg_task_started": {
      const text = `▶ bg ${str(e.taskId)} started: ${str(e.command).slice(0, 80)}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "bg_task_output":
      return { ...s, committed: [...s.committed, { kind: "note", text: str(e.chunk) }] };

    case "bg_task_exited": {
      // Matches main.ts:556's `"exit " + e.exitCode` byte-for-byte, INCLUDING a null exitCode
      // (killed:false, no exit code available) stringifying to "exit null" — no `num()` fallback
      // here, since that would silently turn a real "exit null" into a misleading "exit 0".
      const text = `■ bg ${str(e.taskId)} exited (${e.killed ? "killed" : `exit ${e.exitCode}`})`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "worktree_entered": {
      const text = `⛿ entered worktree ${str(e.name)} (branch ${str(e.branch)})`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "worktree_exited": {
      const text = `⟲ left worktree ${str(e.name)}${e.removed ? " (removed)" : ""}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    case "agent_error": {
      // main.ts:659 sends this to console.error (stderr), not the pinned block — but the Ink app
      // has no separate stderr surface, so its content becomes a committed note here (same wording).
      const text = `agent error: ${str(e.message)}`;
      return { ...s, committed: [...s.committed, { kind: "note", text }] };
    }

    default:
      return s; // unknown/unhandled event types are no-ops (both CLI/app already skip unknowns)
  }
}
