export type StreamAction = "write_delta" | "close_line" | "swallow_final" | "print_full" | "close_then_print_full" | "none";

/** Pure streaming-print decision: the SELECTED thread's (default `"main"`, the pre-2e-iii-b-Task-5
 *  hardcoded behavior) assistant_deltas stream to stdout without a trailing newline; the final
 *  assistant_message then just terminates the line (never double-prints). Any other event arriving
 *  mid-stream closes the dangling partial line (agent_error can end a turn with no
 *  assistant_message). Non-selected-thread deltas are ignored — the CLI renders that thread's
 *  output when its assistant_message arrives, as today. `selectedThreadId` is Task 6's thread
 *  selector; main.ts still passes `"main"` explicitly everywhere today (no behavior change) — see
 *  main-thread streamedChars accounting, which stays keyed to `threadId === "main"` regardless of
 *  selection. */
export function streamAction(
  streaming: boolean,
  e: { type: string; threadId?: string },
  selectedThreadId: string = "main",
): { action: StreamAction; streaming: boolean } {
  if (e.type === "assistant_delta") {
    if (e.threadId === selectedThreadId) return { action: "write_delta", streaming: true };
    return { action: "none", streaming };
  }
  if (e.type === "assistant_message") {
    if (e.threadId === selectedThreadId && streaming) return { action: "swallow_final", streaming: false };
    // A non-selected message landing mid-stream must close the dangling selected-thread line first
    // — unreachable in today's blocking child fan-out, but defensive against future interleaving.
    if (streaming) return { action: "close_then_print_full", streaming: true };
    return { action: "print_full", streaming: false };
  }
  if (streaming) return { action: "close_line", streaming: false };
  return { action: "none", streaming: false };
}
