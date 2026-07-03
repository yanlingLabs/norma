import { chmodSync } from "node:fs";
import { z } from "zod";
import {
  ERR, METHODS, PROTOCOL_VERSION, LineDecoder, encodeLine, parseIncoming,
  HelloParams, SessionCreateParams, SessionAttachParams, SessionSendParams, ApprovalRespondParams,
  SessionAddDirParams, SessionSetCwdParams, TrustDirParams,
  BgListParams, BgPeekParams, BgKillParams, BgKillAllParams,
  SessionSteerParams, SessionInterruptParams, SessionCompactParams, SkillsListParams,
  type SessionEvent, ConnWriter, type WritableSocket,
} from "@norma/protocol";
import type { TokenAuthority } from "../auth/tokens";
import type { SessionStore } from "../sessions/store";
import { SessionHub, type HubClient } from "../sessions/hub";
import type { AgentEngine } from "../agent/engine";
import type { ApprovalBroker } from "../agent/approvals";
import type { SessionDirectories } from "../agent/dirs";
import type { TrustStore } from "../agent/trust";
import type { BackgroundTaskRegistry } from "../agent/bg-registry";
import type { SkillStore } from "../agent/skills";
import { addLocalDir } from "../settings";

interface ConnState {
  decoder: LineDecoder;
  authedRole: string | null;
  clientName: string;
  hubClient: HubClient | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  writer: ConnWriter;
}

export interface IpcServerOptions {
  socketPath: string;
  serverVersion: string;
  tokens: TokenAuthority;
  store: SessionStore;
  hub?: SessionHub;          // shared with the agent engine when the daemon wires one up
  engine?: AgentEngine | null;
  broker?: ApprovalBroker | null;
  dirs?: SessionDirectories; // live allowed-roots per session; addDir/setCwd need it
  trust?: TrustStore;        // per-directory trust; session.create result + daemon.trustDir
  bg?: BackgroundTaskRegistry; // background bash tasks; bg.list/peek/kill/killAll
  skills?: SkillStore;       // discovered SKILL.md skills; skills.list
  helloTimeoutMs?: number;   // default 5000
  maxConnections?: number;   // default 64
  preAuthMaxLine?: number;   // default 64 KiB
}

export interface IpcServer { stop(): void }

class RpcFailure extends Error { constructor(public code: number, message: string) { super(message); } }

export function startIpcServer(opts: IpcServerOptions): IpcServer {
  if (opts.engine && !opts.hub) {
    throw new Error("startIpcServer: an engine requires a shared hub (engine and server must broadcast through the same SessionHub)");
  }
  const hub = opts.hub ?? new SessionHub(opts.store);

  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const maxConnections = opts.maxConnections ?? 64;
  const preAuthMaxLine = opts.preAuthMaxLine ?? 64 * 1024;
  let connections = 0;

  function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
    const result = schema.safeParse(params);
    if (!result.success) {
      throw new RpcFailure(
        ERR.INVALID_PARAMS,
        `invalid params: ${result.error.issues.map((i: z.ZodIssue) => i.path.join(".") || "(root)").join(", ")}`,
      );
    }
    return result.data;
  }

  const server = Bun.listen<ConnState>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        if (connections >= maxConnections) {
          // Bun requires socket.data to be assigned before close() fires.
          // Set a sentinel so the close() guard can detect the capped case.
          (socket as any).data = null;
          socket.end();
          return;
        }
        connections++;
        socket.data = {
          decoder: new LineDecoder(preAuthMaxLine),
          authedRole: null,
          clientName: "",
          hubClient: null,
          helloTimer: setTimeout(() => socket.end(), helloTimeoutMs),
          writer: new ConnWriter(socket as unknown as WritableSocket),
        };
      },
      drain(socket) {
        socket.data?.writer?.onDrain();
      },
      close(socket) {
        if (!socket.data) return; // rejected at cap before data was set (sentinel null)
        connections--;
        if (socket.data.helloTimer) clearTimeout(socket.data.helloTimer);
        if (socket.data.hubClient) hub.detach(socket.data.hubClient);
      },
      async data(socket, chunk) {
        let lines: string[];
        try { lines = socket.data.decoder.push(chunk); }
        catch { socket.end(); return; } // oversized line: hostile or broken peer

        for (const line of lines) {
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
            socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, result }));
          } catch (err) {
            const e = err as Partial<RpcFailure>;
            const code = e.code ?? ERR.INTERNAL;
            const message = e.message ?? "internal error";
            socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, error: { code, message } }));
          }
        }
      },
    },
  });
  chmodSync(opts.socketPath, 0o600);

  async function handle(socket: { data: ConnState }, method: string, params: unknown): Promise<unknown> {
    if (method === METHODS.hello) {
      if (socket.data.authedRole !== null) {
        throw new RpcFailure(ERR.INVALID_REQUEST, "already authenticated — open a new connection to change role");
      }
      const p = parseParams(HelloParams, params);
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcFailure(ERR.VERSION_MISMATCH, `server speaks protocol v${PROTOCOL_VERSION}, client sent v${p.protocolVersion}`);
      }
      if (!(await opts.tokens.verify(p.role, p.token))) {
        throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
      }
      socket.data.authedRole = p.role;
      socket.data.clientName = p.clientName;
      if (socket.data.helloTimer) { clearTimeout(socket.data.helloTimer); socket.data.helloTimer = null; }
      socket.data.decoder = new LineDecoder(); // authed: default 8 MiB line cap
      return { ok: true, serverVersion: opts.serverVersion, protocolVersion: PROTOCOL_VERSION };
    }

    if (socket.data.authedRole === null) throw new RpcFailure(ERR.UNAUTHORIZED, "hello required first");

    switch (method) {
      case METHODS.sessionCreate: {
        const p = parseParams(SessionCreateParams, params);
        const sessionId = opts.store.createSession(p.scope, { cwd: p.cwd, approvalPolicy: p.approvalPolicy });
        const trusted = p.cwd ? (opts.trust?.isTrusted(p.cwd) ?? false) : false;
        return { sessionId, trusted };
      }
      case METHODS.sessionList:
        return { sessions: opts.store.list() };
      case METHODS.sessionAttach: {
        const p = parseParams(SessionAttachParams, params);
        const hubClient: HubClient = {
          clientName: socket.data.clientName,
          deliver(event: SessionEvent): boolean {
            return socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event }));
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
        const p = parseParams(SessionSendParams, params);
        if (!socket.data.hubClient) throw new RpcFailure(ERR.NOT_FOUND, "attach to the session first");
        const seq = hub.send(socket.data.hubClient, p.sessionId, p.text);
        // Fire-and-forget: the response returns immediately and turn events stream separately.
        // If a turn is already running, this message just lands in history for the next turn
        // (full mid-turn steering is deferred).
        if (opts.engine && !opts.engine.isRunning(p.sessionId)) {
          opts.engine.runTurn(p.sessionId).catch((e) => console.error("turn failed:", e));
        }
        return { seq };
      }
      case METHODS.sessionSteer: {
        const p = parseParams(SessionSteerParams, params);
        if (!opts.engine) return { ok: true, injected: false };
        return { ok: true, ...opts.engine.steer(p.sessionId, p.text) };
      }
      case METHODS.sessionInterrupt: {
        const p = parseParams(SessionInterruptParams, params);
        if (!opts.engine) return { ok: true, wasRunning: false };
        return { ok: true, ...opts.engine.interrupt(p.sessionId) };
      }
      case METHODS.sessionCompact: {
        const p = parseParams(SessionCompactParams, params);
        if (!opts.engine) return { ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 };
        return { ok: true, ...(await opts.engine.compact(p.sessionId)) };
      }
      case METHODS.skillsList: {
        const p = parseParams(SkillsListParams, params);
        if (!opts.skills) return { ok: true, skills: [] };
        return { ok: true, skills: opts.skills.list({ cwd: p.cwd ?? null }) };
      }
      case METHODS.approvalRespond: {
        const p = parseParams(ApprovalRespondParams, params);
        return opts.broker?.resolve(p.sessionId, p.callId, p.approved, socket.data.clientName) ?? { ok: true, alreadyResolved: true };
      }
      case METHODS.sessionAddDir: {
        const p = parseParams(SessionAddDirParams, params);
        let meta: ReturnType<SessionStore["meta"]>;
        try {
          meta = opts.store.meta(p.sessionId); // throws for unknown session
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        opts.dirs?.add(p.sessionId, p.path);
        const persisted = p.persist && meta.cwd !== null;
        if (persisted) addLocalDir(meta.cwd!, p.path);
        hub.append(p.sessionId, { type: "directory_added", sessionId: p.sessionId, threadId: "main", path: p.path, persisted });
        return { ok: true, roots: opts.dirs?.roots(p.sessionId) ?? [] };
      }
      case METHODS.sessionSetCwd: {
        const p = parseParams(SessionSetCwdParams, params);
        opts.store.setCwd(p.sessionId, p.cwd);
        return { ok: true, cwd: p.cwd };
      }
      case METHODS.trustDir: {
        const p = parseParams(TrustDirParams, params);
        opts.trust?.trust(p.path);
        return { ok: true, trusted: true };
      }
      case METHODS.bgList: {
        const p = parseParams(BgListParams, params);
        return { tasks: opts.bg?.list(p.sessionId) ?? [] };
      }
      case METHODS.bgPeek: {
        const p = parseParams(BgPeekParams, params);
        if (!opts.bg) throw new RpcFailure(ERR.NOT_FOUND, "background tasks unavailable");
        try {
          return opts.bg.read(p.sessionId, p.taskId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
      }
      case METHODS.bgKill: {
        const p = parseParams(BgKillParams, params);
        if (!opts.bg) throw new RpcFailure(ERR.NOT_FOUND, "background tasks unavailable");
        try {
          opts.bg.kill(p.sessionId, p.taskId);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        return { ok: true };
      }
      case METHODS.bgKillAll: {
        const p = parseParams(BgKillAllParams, params);
        const killed = opts.bg?.list(p.sessionId).filter((t) => t.status === "running").length ?? 0;
        opts.bg?.killAllForSession(p.sessionId);
        return { ok: true, killed };
      }
      default:
        throw new RpcFailure(ERR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { stop() { server.stop(true); } };
}
