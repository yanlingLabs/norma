import { z } from "zod";

export const ProviderEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), callId: z.string().min(1), name: z.string().min(1), argsJson: z.string() }),
  z.object({ type: z.literal("usage"), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
  z.object({ type: z.literal("done"), stopReason: z.enum(["end_turn", "tool_calls", "aborted"]) }),
  z.object({
    type: z.literal("error"),
    code: z.enum(["auth", "rate_limit", "server", "network", "bad_request"]),
    message: z.string(),
    retryAfterMs: z.number().int().positive().optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export interface ModelInfo {
  id: string;
  family: string;
  contextWindow: number;
  supportsVision: boolean;
}

export type TurnInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; callId: string; name: string; argsJson: string }
  | { type: "tool_result"; callId: string; output: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema
}

export interface TurnRequest {
  model: string;
  instructions?: string;
  input: TurnInputItem[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  /** Reasoning-effort slug (settings.ts REASONING_EFFORTS: low/medium/high/xhigh/max/ultra).
   *  Optional — omitted means no `reasoning` field is sent (openai-compatible.ts's
   *  buildRequestBody must stay byte-identical to today's body when this is unset). */
  reasoningEffort?: string;
}

export interface Provider {
  readonly id: string;
  models(): ModelInfo[];
  streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent>;
}
