import { chmodSync } from "node:fs";
import {
  ERR, METHODS, PROTOCOL_VERSION, LineDecoder, encodeLine, parseIncoming,
  HelloParams, SessionCreateParams, SessionAttachParams, SessionSendParams,
  type SessionEvent,
} from "@norma/protocol";
import type { TokenAuthority } from "../auth/tokens";
import type { SessionStore } from "../sessions/store";
import { SessionHub, type HubClient } from "../sessions/hub";

interface ConnState {
  decoder: LineDecoder;
  authedRole: string | null;
  clientName: string;
  hubClient: HubClient | null;
}

export interface IpcServer { stop(): void }

class RpcFailure extends Error { constructor(public code: number, message: string) { super(message); } }

export function startIpcServer(opts: {
  socketPath: string;
  serverVersion: string;
  tokens: TokenAuthority;
  store: SessionStore;
}): IpcServer {
  const hub = new SessionHub(opts.store);

  const server = Bun.listen<ConnState>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { decoder: new LineDecoder(), authedRole: null, clientName: "", hubClient: null };
      },
      close(socket) {
        if (socket.data.hubClient) hub.detach(socket.data.hubClient);
      },
      async data(socket, chunk) {
        for (const line of socket.data.decoder.push(chunk)) {
          let id: number | string | null = null;
          try {
            let incoming: ReturnType<typeof parseIncoming>;
            try {
              incoming = parseIncoming(JSON.parse(line));
            } catch {
              throw new RpcFailure(ERR.PARSE_ERROR, "parse error");
            }
            if (incoming.kind !== "request") continue; // Phase 0: ignore client notifications
            id = incoming.msg.id;
            const result = await handle(socket, incoming.msg.method, incoming.msg.params);
            socket.write(encodeLine({ jsonrpc: "2.0", id, result }));
          } catch (err) {
            const e = err as Partial<RpcFailure>;
            socket.write(encodeLine({
              jsonrpc: "2.0", id,
              error: { code: e.code ?? ERR.INTERNAL, message: e.message ?? "internal error" },
            }));
          }
        }
      },
    },
  });
  chmodSync(opts.socketPath, 0o600);

  async function handle(socket: { write(d: Uint8Array): unknown; data: ConnState }, method: string, params: unknown): Promise<unknown> {
    if (method === METHODS.hello) {
      const p = HelloParams.parse(params);
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcFailure(ERR.VERSION_MISMATCH, `server speaks protocol v${PROTOCOL_VERSION}, client sent v${p.protocolVersion}`);
      }
      if (!(await opts.tokens.verify(p.role, p.token))) {
        throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
      }
      socket.data.authedRole = p.role;
      socket.data.clientName = p.clientName;
      return { ok: true, serverVersion: opts.serverVersion, protocolVersion: PROTOCOL_VERSION };
    }

    if (socket.data.authedRole === null) throw new RpcFailure(ERR.UNAUTHORIZED, "hello required first");

    switch (method) {
      case METHODS.sessionCreate: {
        const p = SessionCreateParams.parse(params);
        return { sessionId: opts.store.createSession(p.scope) };
      }
      case METHODS.sessionList:
        return { sessions: opts.store.list() };
      case METHODS.sessionAttach: {
        const p = SessionAttachParams.parse(params);
        const hubClient: HubClient = {
          clientName: socket.data.clientName,
          deliver(event: SessionEvent) {
            socket.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event }));
          },
        };
        // Detach the old client before attaching a new one (re-attach = move semantics).
        if (socket.data.hubClient) hub.detach(socket.data.hubClient);
        try {
          const lastSeq = hub.attach(hubClient, p.sessionId, p.fromSeq);
          socket.data.hubClient = hubClient;
          return { ok: true, lastSeq };
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
      }
      case METHODS.sessionSend: {
        const p = SessionSendParams.parse(params);
        if (!socket.data.hubClient) throw new RpcFailure(ERR.NOT_FOUND, "attach to the session first");
        return { seq: hub.send(socket.data.hubClient, p.sessionId, p.text) };
      }
      default:
        throw new RpcFailure(ERR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { stop() { server.stop(true); } };
}
