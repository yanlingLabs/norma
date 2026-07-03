import type { SessionEvent } from "@norma/protocol";
import type { Provider, TurnInputItem } from "../providers/types";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";

export const SUMMARIZE_INSTRUCTION =
  "You are compacting a conversation so it can continue seamlessly with less context. " +
  "Summarize everything below, preserving key facts, decisions, identifiers, file paths, and open threads / next steps. " +
  "Be concise but lossless on specifics. Output only the summary.";

const DEFAULT_KEEP_TAIL = 6;
const MAIN_THREAD = "main";

type Message = Extract<SessionEvent, { type: "user_message" | "assistant_message" }>;
type Checkpoint = Extract<SessionEvent, { type: "checkpoint" }>;

function isMessage(e: SessionEvent): e is Message {
  return e.type === "user_message" || e.type === "assistant_message";
}
function isCheckpoint(e: SessionEvent): e is Checkpoint {
  return e.type === "checkpoint";
}

const NOT_COMPACTED = { compacted: false, uptoSeq: 0, summaryChars: 0 } as const;

/** Folds older turns into a checkpoint summary, keeping only the most recent `keepTail`
 *  messages verbatim. Re-compacting an already-checkpointed session folds the prior summary
 *  in as the first input item, so compaction stays lossless across repeated runs. */
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
    // Fold a prior checkpoint's summary into the "older" set so re-compaction stays lossless.
    const lastCp = [...events].reverse().find(isCheckpoint);
    const msgs = events.filter(isMessage);
    const afterCp = lastCp ? msgs.filter((m) => m.seq > lastCp.uptoSeq) : msgs;
    if (afterCp.length <= this.keepTail) return NOT_COMPACTED;

    const older = afterCp.slice(0, afterCp.length - this.keepTail);
    const uptoSeq = older[older.length - 1]!.seq;

    const input: TurnInputItem[] = [];
    if (lastCp) input.push({ type: "message", role: "user", content: "[Prior summary]\n" + lastCp.summary });
    for (const m of older) {
      input.push({ type: "message", role: m.type === "user_message" ? "user" : "assistant", content: m.text });
    }

    let summary = "";
    try {
      for await (const ev of this.provider.provider.streamTurn({
        model: this.provider.model,
        instructions: SUMMARIZE_INSTRUCTION,
        input,
        tools: [],
        signal,
      })) {
        if (ev.type === "text_delta") summary += ev.delta;
        else if (ev.type === "done" && ev.stopReason === "aborted") return NOT_COMPACTED;
      }
    } catch {
      return NOT_COMPACTED;
    }
    if (signal?.aborted || summary.length === 0) return NOT_COMPACTED;

    this.hub.append(sessionId, { type: "checkpoint", sessionId, threadId: MAIN_THREAD, summary, uptoSeq });
    return { compacted: true, uptoSeq, summaryChars: summary.length };
  }
}
