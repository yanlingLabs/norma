export type StreamAction = "write_delta" | "close_line" | "swallow_final" | "print_full" | "close_then_print_full" | "none";

/** Pure streaming-print decision: MAIN-thread assistant_deltas stream to stdout without a
 *  trailing newline; the final assistant_message then just terminates the line (never
 *  double-prints). Any other event arriving mid-stream closes the dangling partial line
 *  (agent_error can end a turn with no assistant_message). Child-thread deltas are ignored —
 *  the CLI renders child output when its assistant_message arrives, as today. */
export function streamAction(
  streaming: boolean,
  e: { type: string; threadId?: string },
): { action: StreamAction; streaming: boolean } {
  if (e.type === "assistant_delta") {
    if (e.threadId === "main") return { action: "write_delta", streaming: true };
    return { action: "none", streaming };
  }
  if (e.type === "assistant_message") {
    if (e.threadId === "main" && streaming) return { action: "swallow_final", streaming: false };
    // A non-main (child) message landing mid-stream must close the dangling main line first —
    // unreachable in today's blocking child fan-out, but defensive against future interleaving.
    if (streaming) return { action: "close_then_print_full", streaming: true };
    return { action: "print_full", streaming: false };
  }
  if (streaming) return { action: "close_line", streaming: false };
  return { action: "none", streaming: false };
}
