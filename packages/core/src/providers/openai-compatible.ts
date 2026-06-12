import type { ModelInfo, Provider, ProviderEvent, TurnInputItem, TurnRequest, ToolSpec } from "./types";
import { ResponsesSseParser } from "./responses-sse";

export interface OpenAICompatibleConfig {
  baseUrl: string;            // e.g. https://api.openai.com/v1
  apiKey: string;
  models?: ModelInfo[];       // optional static list for UI; not validated
  extraHeaders?: Record<string, string>;
}

export function mapInput(items: TurnInputItem[]): unknown[] {
  return items.map((i) =>
    i.type === "message"
      ? { role: i.role, content: i.content }
      : { type: "function_call_output", call_id: i.callId, output: i.output },
  );
}

export function mapTools(tools: ToolSpec[] | undefined): unknown[] | undefined {
  return tools?.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

export function mapHttpError(status: number, retryAfterHeader: string | null): ProviderEvent {
  if (status === 401 || status === 403) return { type: "error", code: "auth", message: `HTTP ${status}` };
  if (status === 429) {
    const secs = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    // HTTP-date form of Retry-After (RFC 7231 §7.1.3) → NaN → omit retryAfterMs; QuotaManager applies fallback.
    // secs <= 0 treated as absent (a "retry immediately" hint still gets default backoff).
    return {
      type: "error", code: "rate_limit", message: `HTTP 429`,
      ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: Math.round(secs * 1000) } : {}),
    };
  }
  if (status >= 400 && status < 500) return { type: "error", code: "bad_request", message: `HTTP ${status}` };
  return { type: "error", code: "server", message: `HTTP ${status}` };
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
        body: JSON.stringify({
          model: req.model,
          ...(req.instructions ? { instructions: req.instructions } : {}),
          input: mapInput(req.input),
          ...(req.tools?.length ? { tools: mapTools(req.tools) } : {}),
          stream: true,
        }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
      return;
    }
    if (!res.ok) { yield mapHttpError(res.status, res.headers.get("retry-after")); return; }

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
