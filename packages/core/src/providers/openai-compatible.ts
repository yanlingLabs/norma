import type { ModelInfo, Provider, ProviderEvent, TurnInputItem, TurnRequest, ToolSpec } from "./types";
import { ResponsesSseParser } from "./responses-sse";

export interface OpenAICompatibleConfig {
  baseUrl: string;            // e.g. https://api.openai.com/v1
  apiKey: string;
  models?: ModelInfo[];       // optional static list for UI; not validated
  extraHeaders?: Record<string, string>;
}

/**
 * Map TurnInputItem[] to the structured Responses API `input` array.
 *
 * Shape verified live 2026-06-13 against https://chatgpt.com/backend-api/codex/responses:
 *   messages  → {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
 *   tool_result → {type:"function_call_output", call_id, output}
 *
 * The flat-string content form ({role, content:"string"}) was rejected with HTTP 400
 * by the codex backend; structured content items are required.
 */
export function mapInput(items: TurnInputItem[]): unknown[] {
  return items.map((i) => {
    if (i.type === "message") {
      // Map role to the appropriate content item type per the Responses API schema.
      // assistant messages use output_text; user/system messages use input_text.
      const contentType = i.role === "assistant" ? "output_text" : "input_text";
      return { type: "message", role: i.role, content: [{ type: contentType, text: i.content }] };
    }
    return { type: "function_call_output", call_id: i.callId, output: i.output };
  });
}

export function mapTools(tools: ToolSpec[] | undefined): unknown[] {
  return (tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

/**
 * Build the standard Responses API request body.
 *
 * Required fields verified live 2026-06-13 (codex-rs ResponsesApiRequest @216dee1):
 *   tools, tool_choice, parallel_tool_calls, store, include — all required by backend;
 *   omitting them causes HTTP 400.
 * instructions: codex-rs skips when empty string; we always send a default so the
 *   field is never absent when the caller omits it.
 */
export function buildRequestBody(req: TurnRequest): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.instructions ?? "You are a helpful assistant.",
    input: mapInput(req.input),
    tools: mapTools(req.tools),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
}

export async function mapHttpError(status: number, retryAfterHeader: string | null, body: Promise<string>): Promise<ProviderEvent> {
  const snippet = (await body.catch(() => "")).slice(0, 200);
  const suffix = snippet ? ` — ${snippet}` : "";
  if (status === 401 || status === 403) return { type: "error", code: "auth", message: `HTTP ${status}${suffix}` };
  if (status === 429) {
    const secs = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    // HTTP-date form of Retry-After (RFC 7231 §7.1.3) → NaN → omit retryAfterMs; QuotaManager applies fallback.
    // secs <= 0 treated as absent (a "retry immediately" hint still gets default backoff).
    return {
      type: "error", code: "rate_limit", message: `HTTP 429${suffix}`,
      ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: Math.round(secs * 1000) } : {}),
    };
  }
  if (status >= 400 && status < 500) return { type: "error", code: "bad_request", message: `HTTP ${status}${suffix}` };
  return { type: "error", code: "server", message: `HTTP ${status}${suffix}` };
}

export class OpenAICompatibleProvider implements Provider {
  readonly id = "openai-compatible";
  constructor(private readonly cfg: OpenAICompatibleConfig) {}

  models(): ModelInfo[] { return this.cfg.models ?? []; }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...this.cfg.extraHeaders,
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
      return;
    }
    if (!res.ok) { yield await mapHttpError(res.status, res.headers.get("retry-after"), res.text()); return; }

    const parser = new ResponsesSseParser();
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(value)) yield e;
      }
      for (const e of parser.finish()) yield e;
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
