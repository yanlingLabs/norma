import type { SessionEvent } from "@norma/protocol";
import type { Provider, TurnInputItem } from "../providers/types";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";

export const SUMMARIZE_INSTRUCTION =
  "You are compacting a conversation so it can continue with less context. " +
  "Summarize the messages below. " +
  "Write the summary as clear DECLARATIVE statements of what is true and what was decided — e.g. 'The user's lucky number is 4242.' — NOT as a paraphrase of the most recent message or an echo of an acknowledgement. " +
  "Preserve all specifics (numbers, names, paths, identifiers, exact values) verbatim. Be concise but complete; do not sacrifice a fact for brevity. Output only the summary text.";

const DEFAULT_KEEP_TAIL = 6;
const MAIN_THREAD = "main";

type Message = Extract<SessionEvent, { type: "user_message" | "assistant_message" }>;
type Checkpoint = Extract<SessionEvent, { type: "checkpoint" }>;
type ToolCall = Extract<SessionEvent, { type: "tool_call" }>;
type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

function isMessage(e: SessionEvent): e is Message {
  return e.type === "user_message" || e.type === "assistant_message";
}
function isCheckpoint(e: SessionEvent): e is Checkpoint {
  return e.type === "checkpoint";
}
function isToolCall(e: SessionEvent): e is ToolCall {
  return e.type === "tool_call";
}
function isToolResult(e: SessionEvent): e is ToolResult {
  return e.type === "tool_result";
}

const NOT_COMPACTED = { compacted: false, uptoSeq: 0, summaryChars: 0 } as const;

/** Folds older turns into a checkpoint summary, keeping only the most recent `keepTail`
 *  messages verbatim. Re-compacting an already-checkpointed session NEVER re-feeds the prior
 *  checkpoint's summary to the model — under repeated re-compression the model reliably drops
 *  facts from a folded-in summary. Instead the prior summary is carried forward VERBATIM and
 *  concatenated with a fresh summary of only the newest "older" messages, so every fact
 *  survives every re-compaction. */
export class Compactor {
  private readonly provider: { provider: Provider; model: string };
  private readonly store: SessionStore;
  private readonly hub: SessionHub;
  private readonly keepTail: number;

  constructor(deps: { provider: { provider: Provider; model: string }; store: SessionStore; hub: SessionHub; keepTail?: number }) {
    this.provider = deps.provider;
    this.store = deps.store;
    this.hub = deps.hub;
    this.keepTail = deps.keepTail ?? DEFAULT_KEEP_TAIL;
  }

  async compact(sessionId: string, signal?: AbortSignal): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    const events = this.store.read(sessionId);
    const lastCp = [...events].reverse().find(isCheckpoint);
    const msgs = events.filter(isMessage);
    const afterCp = lastCp ? msgs.filter((m) => m.seq > lastCp.uptoSeq) : msgs;
    if (afterCp.length <= this.keepTail) return NOT_COMPACTED;

    const older = afterCp.slice(0, afterCp.length - this.keepTail);
    const candidateUptoSeq = older[older.length - 1]!.seq;

    // Clamp the candidate so it never lands strictly INSIDE an unresolved main-thread
    // tool_call/tool_result pair. This is reachable in production, not just theoretical:
    // AgentEngine.steer() appends `user_message` events to the store IMMEDIATELY, even while a
    // tool call sits mid-flight awaiting approval (default approval timeout is 5 minutes). If a
    // steer flood of more than `keepTail` messages lands during that window and a manual
    // `compact` IPC call (a live method, callable mid-turn — see AgentEngine.compact) fires in
    // it, the naive candidate above — derived purely from MESSAGE seqs — can sit strictly between
    // the pending tool_call's seq and its (not-yet-emitted, or never-emitted) tool_result's seq.
    // historyInput's `seq <= uptoSeq` would then fold the function_call but keep the later
    // tool_result, orphaning it in the provider input on replay -> hard reject. So: find the
    // EARLIEST main-thread tool_call at or before the candidate whose matching tool_result (same
    // callId) is missing or lands AFTER the candidate, and pull the boundary back to the last
    // message strictly before that call — folding only what's fully resolved. Scoped to the MAIN
    // thread only, consistent with historyInput's own thread filter (child-thread tool events
    // never enter main replay, so they can never be split by a main checkpoint either).
    const mainToolCalls = events.filter(isToolCall).filter((e) => e.threadId === MAIN_THREAD);
    const mainToolResultSeqByCallId = new Map<string, number>();
    for (const e of events) {
      if (isToolResult(e) && e.threadId === MAIN_THREAD) mainToolResultSeqByCallId.set(e.callId, e.seq);
    }
    let earliestOffenderSeq: number | null = null;
    for (const tc of mainToolCalls) {
      if (tc.seq > candidateUptoSeq) continue;
      const resultSeq = mainToolResultSeqByCallId.get(tc.callId);
      if (resultSeq === undefined || resultSeq > candidateUptoSeq) {
        if (earliestOffenderSeq === null || tc.seq < earliestOffenderSeq) earliestOffenderSeq = tc.seq;
      }
    }
    let uptoSeq = candidateUptoSeq;
    if (earliestOffenderSeq !== null) {
      const safeOlder = afterCp.filter((m) => m.seq < earliestOffenderSeq!);
      if (safeOlder.length === 0) return NOT_COMPACTED; // nothing safely foldable before the pending pair
      uptoSeq = safeOlder[safeOlder.length - 1]!.seq;
    }
    const olderClamped = afterCp.filter((m) => m.seq <= uptoSeq);

    // Only the new "older" messages go to the model — the prior summary is never re-fed, so it
    // can never be eroded by re-summarization.
    const input: TurnInputItem[] = olderClamped.map((m) => ({
      type: "message",
      role: m.type === "user_message" ? "user" : "assistant",
      content: m.text,
    }));

    let newPartial = "";
    try {
      for await (const ev of this.provider.provider.streamTurn({
        model: this.provider.model,
        instructions: SUMMARIZE_INSTRUCTION,
        input,
        tools: [],
        signal,
      })) {
        if (ev.type === "text_delta") newPartial += ev.delta;
        else if (ev.type === "done" && ev.stopReason === "aborted") return NOT_COMPACTED;
      }
    } catch {
      return NOT_COMPACTED;
    }
    if (signal?.aborted || newPartial.trim().length === 0) return NOT_COMPACTED;

    // Carry the prior summary forward VERBATIM and append the freshly summarized section, so the
    // cumulative summary only ever grows and never re-erodes earlier facts.
    const summary = lastCp ? lastCp.summary + "\n\n" + newPartial : newPartial;

    this.hub.append(sessionId, { type: "checkpoint", sessionId, threadId: MAIN_THREAD, summary, uptoSeq });
    return { compacted: true, uptoSeq, summaryChars: summary.length };
  }
}
