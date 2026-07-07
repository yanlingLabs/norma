/** Pure child-thread tracking for the CLI's live subagent block (2e-ii) — the CLI column of the
 *  spec's §2 table: lifecycle + TOKEN counters only (no time — the active timer is window-only;
 *  the Swift twin in SessionModel.swift tracks spans instead). Reducer-style like stream-state.ts:
 *  `updateSubagents(items, event)` returns a NEW array on change and the SAME reference on a
 *  no-op, so callers can cheaply skip repaints. */

import { subagentLabel } from "./subagent-display";

export interface CliSubagent {
  threadId: string;
  agentType: string;
  label: string;
  status: string; // "queued" | "working" | "done"
  inputTokens?: number; // latest child turn_completed.inputTokens — unknown until the first
  outputTokens: number; // banked sum of child turn_completed.outputTokens
  liveOutputChars: number; // child assistant_delta chars since the last reconcile (↓ estimate /4)
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
      }];
    }
    case "turn_started":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, status: "working" }));
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
      }));
    case "thread_completed":
      return patch(items, threadId, (s) => ({ ...s, status: "done" }));
    case "agent_error":
      if (threadId === "main") return items.length ? [] : items; // defensive prune
      return items;
    default:
      return items;
  }
}
