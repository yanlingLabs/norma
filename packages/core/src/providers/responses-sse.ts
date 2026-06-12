import { ProviderEvent } from "./types";

/** Incremental SSE frame splitter + Responses-API event mapper. */
export class ResponsesSseParser {
  private buf = "";
  private decoder = new TextDecoder();
  private sawToolCall = false;

  push(chunk: Uint8Array): ProviderEvent[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const out: ProviderEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const mapped = this.mapFrame(frame);
      if (mapped) out.push(...mapped);
    }
    return out;
  }

  /** Flush at stream end (handles a final frame without trailing blank line). */
  finish(): ProviderEvent[] {
    const rest = this.buf.trim();
    this.buf = "";
    if (!rest) return [];
    return this.mapFrame(rest) ?? [];
  }

  private mapFrame(frame: string): ProviderEvent[] | null {
    let dataLine = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!dataLine || dataLine === "[DONE]") return null;
    let data: any;
    try { data = JSON.parse(dataLine); } catch { return null; } // tolerate junk frames
    switch (data.type) {
      case "response.output_text.delta":
        return [{ type: "text_delta", delta: String(data.delta ?? "") }];
      case "response.output_item.done":
        if (data.item?.type === "function_call") {
          this.sawToolCall = true;
          return [{
            type: "tool_call",
            callId: String(data.item.call_id),
            name: String(data.item.name),
            argsJson: String(data.item.arguments ?? ""),
          }];
        }
        return null;
      case "response.completed": {
        const out: ProviderEvent[] = [];
        const u = data.response?.usage;
        if (u) out.push({ type: "usage", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 });
        out.push({ type: "done", stopReason: this.sawToolCall ? "tool_calls" : "end_turn" });
        return out;
      }
      case "response.failed":
        return [{ type: "error", code: "server", message: String(data.response?.error?.message ?? "response.failed") }];
      default:
        return null; // forward compat: ignore unknown event types (incl. argument deltas — we use the final item)
    }
  }
}
