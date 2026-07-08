import { chmodSync } from "node:fs";
import { z } from "zod";
import {
  ERR, METHODS, PROTOCOL_VERSION, LineDecoder, encodeLine, parseIncoming,
  HelloParams, SessionCreateParams, SessionAttachParams, SessionSendParams, ApprovalRespondParams,
  SessionAddDirParams, SessionSetCwdParams, TrustDirParams,
  BgListParams, BgPeekParams, BgKillParams, BgKillAllParams,
  SessionSteerParams, SessionInterruptParams, SessionCompactParams, SkillsListParams, McpListParams,
  PluginsListParams, AskUserRespondParams, TaskListParams, PlanRespondParams, SessionSetPolicyParams,
  ThreadListParams,
  PeripheralLeaseParams, PeripheralRenewParams, PeripheralReleaseParams, PeripheralAdvertiseParams,
  PeripheralRevokeParams, PeripheralRespondParams, DaemonStatusParams, QuotaStateParams,
  TrustListParams, TrustRemoveParams, PluginRevokeTokenParams,
  type SessionEvent, ConnWriter, type WritableSocket,
} from "@norma/protocol";
import type { TokenAuthority } from "../auth/tokens";
import type { SessionStore } from "../sessions/store";
import { SessionHub, type HubClient } from "../sessions/hub";
import type { AgentEngine } from "../agent/engine";
import type { ApprovalBroker } from "../agent/approvals";
import type { QuestionBroker } from "../agent/questions";
import type { TaskStore } from "../agent/task-store";
import type { PlanBroker } from "../agent/plans";
import type { SessionDirectories } from "../agent/dirs";
import type { TrustStore } from "../agent/trust";
import type { BackgroundTaskRegistry } from "../agent/bg-registry";
import type { SkillStore } from "../agent/skills";
import type { McpManager } from "../agent/mcp/manager";
import type { PluginStore } from "../agent/plugins";
import type { PeripheralBroker } from "../peripheral/broker";
import type { ProviderLink } from "../peripheral/provider-link";
import type { QuotaManager } from "../providers/quota";
import { addLocalDir } from "../settings";

interface ConnState {
  decoder: LineDecoder;
  authedRole: string | null;
  clientName: string;
  hubClient: HubClient | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  writer: ConnWriter;
  // Phase 4b Task 2: set on a successful role:"plugin" hello (the specific installed plugin id
  // this connection authenticated as); null for every other role. Consumed by Task 3/4's
  // supervisor wiring (notifyRegistered/tool bridge) to correlate a connection to its plugin.
  pluginId: string | null;
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
  mcp?: McpManager;          // MCP servers started at boot; mcp.list
  plugins?: PluginStore;     // discovered ~/.norma/plugins/*; plugins.list
  questions?: QuestionBroker; // in-flight ask_user questions; ask_user.respond
  tasks?: TaskStore;         // session task lists; task.list
  plans?: PlanBroker;        // in-flight exit_plan_mode plans; plan.respond
  peripheral?: PeripheralBroker; // lease machinery; peripheral.* verbs (Phase 2f)
  providerLink?: ProviderLink;   // bridges PeripheralBroker.call()'s pushToProvider to the live
                                  // provider connection this server tracks (Phase 2f)
  quota?: QuotaManager;      // token/rate-limit snapshot; quota.state (dashboard read)
  providerInfo?: { id: string; model: string } | null; // active LLM provider identity; daemon.status
  startedAt?: number;        // daemon process start time (Date.now()); daemon.status uptimeMs
  helloTimeoutMs?: number;   // default 5000
  maxConnections?: number;   // default 64
  preAuthMaxLine?: number;   // default 64 KiB
}

export interface IpcServer { stop(): void }

class RpcFailure extends Error { constructor(public code: number, message: string) { super(message); } }

// Phase 4b Task 2 (spec §3): the table-driven role→methods gate for plugin connections. A plugin
// authenticates as a SPECIFIC installed plugin id (hello role "plugin") and may ONLY ever call
// these six wire verbs — everything else (session.*, approval.*, peripheral.*, daemon.*, trust.*,
// plugins.*, ask_user.*, etc.) is role-rejected BEFORE dispatch, never reaching a handler. Handlers
// for these six aren't all wired yet (plugin.register/tool.register/shortcut.register/tile.update/
// provider.register land in Task 4) — an allowed-but-unwired method falls through to the switch's
// existing METHOD_NOT_FOUND default, which is the correct "not yet implemented" signal, distinct
// from a role rejection.
const PLUGIN_ALLOWED_METHODS = new Set<string>([
  METHODS.pluginRegister,
  METHODS.toolRegister,
  METHODS.shortcutRegister,
  METHODS.tileUpdate,
  METHODS.providerRegister,
  METHODS.pluginToolResult,
]);

export function startIpcServer(opts: IpcServerOptions): IpcServer {
  if (opts.engine && !opts.hub) {
    throw new Error("startIpcServer: an engine requires a shared hub (engine and server must broadcast through the same SessionHub)");
  }
  const hub = opts.hub ?? new SessionHub(opts.store);

  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const maxConnections = opts.maxConnections ?? 64;
  const preAuthMaxLine = opts.preAuthMaxLine ?? 64 * 1024;
  let connections = 0;

  // Every currently-authed harness-role connection, across all sessions. A brand-new session has
  // no attachments yet, so its session_created event can't reach anyone through the hub's
  // per-session fan-out — instead it's broadcast here to every harness so other harnesses (e.g. an
  // orb attached to a different, older session) learn about it and can offer to follow (spec §4.4).
  // Added on successful hello (role === "harness"); removed on socket close.
  const harnessConns = new Set<ConnState>();

  // session_titled (Task 3) is broadcast to EVERY authed harness, not just clients attached to
  // that session — mirrors the session.create broadcast above for the same reason: a harness
  // watching the session list (but not attached to this particular session) still needs to learn
  // its title live. Attached harnesses may receive it twice (fanOut + this); seq-based dedupe
  // absorbs that (NormaKit dedupes on seq; the CLI ignores unknown/duplicate event types).
  hub.onGlobalEvent = (event) => {
    for (const conn of harnessConns) {
      try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })); }
      catch { /* dead socket — its close() handler will evict it from harnessConns */ }
    }
  };

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
          pluginId: null,
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
        harnessConns.delete(socket.data);
        // Provider disconnect (spec §A3): only the connection that most recently advertised
        // counts — isProvider() is checked BEFORE providerGone() resets the broker's identity.
        if (opts.peripheral?.isProvider(socket.data)) {
          opts.peripheral.providerGone();
          opts.providerLink?.setWriter(null);
        }
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
      // Phase 4b Task 2: role "plugin" is id-bound and verified against SessionStore's sqlite-
      // hashed plugin_tokens table (mintPluginToken/verifyPluginToken), NOT TokenAuthority — a
      // plugin's token has nothing to do with the harness/admin Keychain secrets. A hello with no
      // pluginId, or one whose token doesn't match what was minted for that exact id, fails closed.
      if (p.role === "plugin") {
        if (!p.pluginId || !opts.store.verifyPluginToken(p.pluginId, p.token)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
        }
      } else if (!(await opts.tokens.verify(p.role, p.token))) {
        throw new RpcFailure(ERR.UNAUTHORIZED, "invalid token for role");
      }
      socket.data.authedRole = p.role;
      socket.data.clientName = p.clientName;
      socket.data.pluginId = p.role === "plugin" ? p.pluginId! : null;
      if (socket.data.helloTimer) { clearTimeout(socket.data.helloTimer); socket.data.helloTimer = null; }
      socket.data.decoder = new LineDecoder(); // authed: default 8 MiB line cap
      if (p.role === "harness") harnessConns.add(socket.data);
      return { ok: true, serverVersion: opts.serverVersion, protocolVersion: PROTOCOL_VERSION };
    }

    if (socket.data.authedRole === null) throw new RpcFailure(ERR.UNAUTHORIZED, "hello required first");

    // Role→method allowlist gate — BEFORE dispatch, ahead of the switch below (Task 2 contract).
    if (socket.data.authedRole === "plugin" && !PLUGIN_ALLOWED_METHODS.has(method)) {
      throw new RpcFailure(ERR.UNAUTHORIZED, `plugin role may not call ${method}`);
    }

    switch (method) {
      case METHODS.sessionCreate: {
        const p = parseParams(SessionCreateParams, params);
        const sessionId = opts.store.createSession(p.scope, { cwd: p.cwd, approvalPolicy: p.approvalPolicy });
        const trusted = p.cwd ? (opts.trust?.isTrusted(p.cwd) ?? false) : false;
        // Broadcast the session_created event to every authed harness (not just attachments —
        // a brand-new session has none) so other harnesses can offer to follow (spec §4.4).
        const created = opts.store.read(sessionId, 0)[0];
        if (created) {
          for (const conn of harnessConns) {
            try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: created })); }
            catch { /* dead socket — its close() handler will evict it from harnessConns */ }
          }
        }
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
      case METHODS.mcpList: {
        const p = parseParams(McpListParams, params);
        if (p.cwd) await opts.mcp?.ensureProject(p.cwd);
        return { ok: true, servers: opts.mcp?.list(p.cwd) ?? [] };
      }
      case METHODS.pluginsList: {
        parseParams(PluginsListParams, params);
        return { ok: true, plugins: opts.plugins?.list() ?? [] };
      }
      case METHODS.approvalRespond: {
        const p = parseParams(ApprovalRespondParams, params);
        return opts.broker?.resolve(p.sessionId, p.callId, p.approved, socket.data.clientName) ?? { ok: true, alreadyResolved: true };
      }
      case METHODS.askUserRespond: {
        const p = parseParams(AskUserRespondParams, params);
        return opts.questions?.respond(p.sessionId, p.callId, p.answers, socket.data.clientName) ?? { ok: true, alreadyResolved: true };
      }
      case METHODS.taskList: {
        const p = parseParams(TaskListParams, params);
        return { ok: true, tasks: opts.tasks?.list(p.sessionId) ?? [] };
      }
      case METHODS.threadList: {
        const p = parseParams(ThreadListParams, params);
        return { ok: true, threads: opts.engine?.threadsFor(p.sessionId) ?? [] };
      }
      case METHODS.planRespond: {
        const p = parseParams(PlanRespondParams, params);
        return (
          opts.plans?.respond(
            p.sessionId, p.callId,
            { approved: p.approved, feedback: p.feedback, autoAccept: p.autoAccept },
            socket.data.clientName,
          ) ?? { ok: true, alreadyResolved: true }
        );
      }
      case METHODS.sessionSetPolicy: {
        const p = parseParams(SessionSetPolicyParams, params);
        try {
          opts.store.setApprovalPolicy(p.sessionId, p.policy);
        } catch (e) {
          throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message);
        }
        return { ok: true };
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

      // -----------------------------------------------------------------------------------------
      // Peripheral lease v1 (Phase 2f, spec §A1/§A2). Requester scope is SESSIONS-ONLY in v1: a
      // non-"harness" role (the plugin role doesn't exist end-to-end yet — TokenAuthority.verify
      // has no plugin token, so this guard is defensive/future-proofing) gets the typed denied
      // result the spec pins, rather than a bare role-rejection error — see spec §A2 "Requester
      // scope" and the plan's Task 3 carried item #4.
      // -----------------------------------------------------------------------------------------
      case METHODS.peripheralLease: {
        const p = parseParams(PeripheralLeaseParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "no_provider" };
        return await opts.peripheral.lease({ sessionId: p.sessionId, class: p.class });
      }
      case METHODS.peripheralRenew: {
        const p = parseParams(PeripheralRenewParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "not_found" };
        return opts.peripheral.renew({ leaseId: p.leaseId, token: p.token });
      }
      case METHODS.peripheralRelease: {
        const p = parseParams(PeripheralReleaseParams, params);
        if (socket.data.authedRole !== "harness") return { code: "denied", reason: "plugin-leasing-not-yet-available" };
        try { opts.store.meta(p.sessionId); } catch (e) { throw new RpcFailure(ERR.NOT_FOUND, (e as Error).message); }
        if (!opts.peripheral) return { code: "not_found" };
        return opts.peripheral.release({ leaseId: p.leaseId, token: p.token });
      }
      case METHODS.peripheralAdvertise: {
        const p = parseParams(PeripheralAdvertiseParams, params);
        // Pin (Task 3 carried item #3): THE provider = the connection that most recently
        // advertised — any authed harness may advertise; last write wins (mirrors
        // PeripheralBroker.advertise's own "last advertiser wins" semantics).
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.advertise requires harness role");
        }
        opts.peripheral?.advertise(socket.data, p.classes, socket.data.clientName);
        opts.providerLink?.setWriter(socket.data.writer);
        return { ok: true };
      }
      case METHODS.peripheralRevoke: {
        const p = parseParams(PeripheralRevokeParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.revoke requires the active provider connection");
        }
        return opts.peripheral.revoke({ leaseId: p.leaseId, all: p.all, reason: p.reason });
      }
      case METHODS.peripheralRespond: {
        const p = parseParams(PeripheralRespondParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "peripheral.respond requires the active provider connection");
        }
        return opts.peripheral.respond({ requestId: p.requestId, resultJson: p.resultJson, error: p.error });
      }

      // -----------------------------------------------------------------------------------------
      // Dashboard read methods (Phase 2f, spec Part B). All read-only except trust.remove.
      // -----------------------------------------------------------------------------------------
      case METHODS.daemonStatus: {
        parseParams(DaemonStatusParams, params);
        return {
          version: opts.serverVersion,
          uptimeMs: Date.now() - (opts.startedAt ?? Date.now()),
          socketPath: opts.socketPath,
          provider: opts.providerInfo ?? null,
          sessionsCount: opts.store.list().length,
          pluginsCount: 0, // Phase 4
        };
      }
      case METHODS.quotaState: {
        parseParams(QuotaStateParams, params);
        const state = opts.quota?.state() ?? { kind: "ok" as const };
        const usage = opts.quota?.usage() ?? { inputTokens: 0, outputTokens: 0 };
        return { ...state, ...usage }; // FLAT merge — see carried item #2 (matches the NormaKit wrapper)
      }
      case METHODS.trustList: {
        parseParams(TrustListParams, params);
        return { dirs: opts.trust?.list() ?? [] };
      }
      case METHODS.trustRemove: {
        const p = parseParams(TrustRemoveParams, params);
        // No admin-gating precedent exists on this socket yet (daemon.trustDir has none either) —
        // fall back to harness-role + an audit log line, per the plan's Task 3 interface note.
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "trust.remove requires harness role");
        }
        const removed = opts.trust?.remove(p.path) ?? false;
        console.error(`[trust.remove] path=${p.path} removed=${removed} by=${socket.data.clientName}`);
        return { removed };
      }

      // -----------------------------------------------------------------------------------------
      // plugin.revokeToken (Phase 4b Task 2, spec §3): harness-role admin verb, same precedent as
      // trust.remove above — NOT one of the six plugin-role verbs (rejected by the allowlist gate
      // above before ever reaching here if called from a plugin connection). The CLI's `norma
      // plugin disable/remove` call this best-effort instead of opening the daemon's sqlite
      // directly (locking risk) — mint stays daemon-side (Task 3, lazily at supervisor spawn).
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRevokeToken: {
        const p = parseParams(PluginRevokeTokenParams, params);
        if (socket.data.authedRole !== "harness") {
          throw new RpcFailure(ERR.UNAUTHORIZED, "plugin.revokeToken requires harness role");
        }
        opts.store.revokePluginToken(p.pluginId);
        return { ok: true };
      }

      default:
        throw new RpcFailure(ERR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { stop() { server.stop(true); } };
}
