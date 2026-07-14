/** Pure child-thread tracking for the CLI's live subagent block (2e-ii, extended 2e-iii-b) — the
 *  CLI column of the spec's §2 table: lifecycle, TOKEN counters, active-time spans, tool-call
 *  counts, and current-activity text (the CLI now shows BOTH time and tokens, mirroring the
 *  Swift twin's span-tracking in SessionModel.swift). Reducer-style like stream-state.ts:
 *  `updateSubagents(items, event)` returns a NEW array on change and the SAME reference on a
 *  no-op, so callers can cheaply skip repaints. */

import { extractToolDetail, subagentLabel } from "./subagent-display";

export interface CliSubagent {
  threadId: string;
  agentType: string;
  label: string;
  status: string; // "queued" | "working" | "done"
  // Roster honesty (no-timeout task): HOW the thread finished, derived from the wire's own
  // thread_completed.stopReason (end_turn → "done", error → "failed", aborted → "stopped").
  // ADDITIVE alongside `status` — `status` stays "done" for EVERY terminal thread on purpose:
  // it is the single terminal marker all the prune/footer filters (`status !== "done"`) and the
  // Swift-lockstep helpers (subagent-display.ts subagentGlyph/anySubagentAlive) key off, and
  // those must not fork per finish kind. Renderers that want the honest verb (agent-list.tsx's
  // continuation row, tui/state.ts's finish note) read `finish` instead; a STALLED child arrives
  // as stopReason "error" → "failed" (the wire carries no distinct stall reason — protocol
  // change deferred, see the no-timeout task report).
  finish?: "done" | "failed" | "stopped";
  inputTokens?: number; // latest child turn_completed.inputTokens — unknown until the first
  outputTokens: number; // banked sum of child turn_completed.outputTokens
  liveOutputChars: number; // child assistant_delta chars since the last reconcile (↓ estimate /4)
  activeMs: number; // banked active time from completed turn windows (event-ts deltas, never Date.now())
  activeSince?: number; // event ts the current turn window opened; undefined while not mid-turn
  toolCalls: number; // count of child tool_call events
  activity?: string; // extractToolDetail() of the most recent tool_call that yielded a detail
}

type WireEvent = { type: string; threadId?: string; [k: string]: unknown };

function patch(items: CliSubagent[], threadId: string, f: (s: CliSubagent) => CliSubagent): CliSubagent[] {
  const idx = items.findIndex((s) => s.threadId === threadId);
  if (idx === -1) return items; // ghost threadId (attached mid-batch) — no-op
  const next = items.slice();
  next[idx] = f(items[idx]!);
  return next;
}

export function updateSubagents(items: CliSubagent[], e: WireEvent): CliSubagent[] {
  const threadId = typeof e.threadId === "string" ? e.threadId : "";
  switch (e.type) {
    case "thread_started": {
      if (items.some((s) => s.threadId === threadId)) return items; // replay dedupe
      return [...items, {
        threadId,
        agentType: typeof e.agentType === "string" ? e.agentType : "",
        label: subagentLabel(typeof e.description === "string" ? e.description : undefined,
          typeof e.prompt === "string" ? e.prompt : ""),
        status: "queued",
        outputTokens: 0,
        liveOutputChars: 0,
        activeMs: 0,
        toolCalls: 0,
      }];
    }
    case "turn_started":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, status: "working", activeSince: typeof e.ts === "number" ? e.ts : s.activeSince }));
    case "assistant_delta":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, liveOutputChars: s.liveOutputChars + String(e.delta ?? "").length }));
    case "turn_completed":
      if (threadId === "main") return items.length ? [] : items; // prune: children finish first
      return patch(items, threadId, (s) => ({
        ...s,
        inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : s.inputTokens,
        outputTokens: s.outputTokens + (typeof e.outputTokens === "number" ? e.outputTokens : 0),
        liveOutputChars: 0, // reconciled — the banked outputTokens now carries this turn's output
        ...closeSpan(s, e),
      }));
    case "thread_completed":
      // status is ALWAYS "done" (the terminal marker — see the `finish` field's doc comment);
      // `finish` carries the honest verdict off the event's own stopReason.
      return patch(items, threadId, (s) => ({
        ...s,
        status: "done",
        finish: e.stopReason === "error" ? "failed" : e.stopReason === "aborted" ? "stopped" : "done",
        ...closeSpan(s, e),
      }));
    case "tool_call": {
      if (threadId === "main") return items;
      const name = typeof e.name === "string" ? e.name : "";
      const argsJson = typeof e.argsJson === "string" ? e.argsJson : "";
      return patch(items, threadId, (s) => ({
        ...s,
        toolCalls: s.toolCalls + 1,
        activity: extractToolDetail(name, argsJson) ?? s.activity,
      }));
    }
    case "agent_error":
      if (threadId === "main") return items.length ? [] : items; // defensive prune
      return items;
    default:
      return items;
  }
}

/** Banks the open `activeSince` span (event-ts delta, clamped ≥ 0) into `activeMs` and clears
 *  `activeSince` — shared by `turn_completed`'s normal close and `thread_completed`'s defensive
 *  close (e.g. an aborted child that never got a matching `turn_completed`). A no-op patch
 *  (`{}`-spread-safe) when there's no open span or no usable `ts`. */
function closeSpan(s: CliSubagent, e: WireEvent): Pick<CliSubagent, "activeMs" | "activeSince"> {
  const ts = typeof e.ts === "number" ? e.ts : undefined;
  if (s.activeSince === undefined || ts === undefined) return { activeMs: s.activeMs, activeSince: undefined };
  return { activeMs: s.activeMs + Math.max(0, ts - s.activeSince), activeSince: undefined };
}
