import { z } from "zod";

export const RpcId = z.union([z.number(), z.string()]);

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
}).refine((m) => !("id" in m), { message: "notifications must not carry an id" });
export type RpcNotification = z.infer<typeof RpcNotification>;

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const RpcResponse = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId, error: RpcError }),
]);
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
