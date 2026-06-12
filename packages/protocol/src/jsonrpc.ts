import { z } from "zod";

export const RpcId = z.union([z.number(), z.string()]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcResponseId = z.union([z.number(), z.string(), z.null()]);
export type RpcResponseId = z.infer<typeof RpcResponseId>;

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcNotification = z.looseObject({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
}).refine((m) => !("id" in m), { message: "notifications must not carry an id" })
  .transform(({ jsonrpc, method, params }) => ({ jsonrpc, method, params }));
export type RpcNotification = z.infer<typeof RpcNotification>;

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export type RpcSuccess = { jsonrpc: "2.0"; id: RpcResponseId; result: unknown };
export type RpcFailure = { jsonrpc: "2.0"; id: RpcResponseId; error: RpcError };
export type RpcResponseShape = RpcSuccess | RpcFailure;

const RpcSuccessResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcResponseId,
  result: z.unknown(),
});
const RpcErrorResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcResponseId,
  error: RpcError,
});

export const RpcResponse = z
  .union([RpcSuccessResponse, RpcErrorResponse])
  .superRefine((m, ctx) => {
    const hasResult = "result" in m && m.result !== undefined;
    const hasError = "error" in m;
    if (hasResult === hasError) {
      ctx.addIssue({ code: "custom", message: "response must carry exactly one of result | error" });
    }
  })
  .transform((m): RpcResponseShape =>
    "error" in m
      ? { jsonrpc: m.jsonrpc, id: m.id, error: (m as { error: RpcError }).error }
      : { jsonrpc: m.jsonrpc, id: m.id, result: (m as { result: unknown }).result },
  );
export type RpcResponse = z.infer<typeof RpcResponse>;

export type Incoming =
  | { kind: "request"; msg: RpcRequest }
  | { kind: "notification"; msg: RpcNotification }
  | { kind: "response"; msg: RpcResponse };

export function parseIncoming(raw: unknown): Incoming {
  const o = z.looseObject({ jsonrpc: z.literal("2.0") }).parse(raw);
  if ("method" in o && "id" in o) return { kind: "request", msg: RpcRequest.parse(raw) };
  if ("method" in o) return { kind: "notification", msg: RpcNotification.parse(raw) };
  return { kind: "response", msg: RpcResponse.parse(raw) };
}

// Error codes (spec §5) — reserve now, used by core later.
export const ERR = {
  UNAUTHORIZED: -32001,
  VERSION_MISMATCH: -32002,
  NOT_FOUND: -32004,
  ALREADY_ATTACHED: -32005,
} as const;
