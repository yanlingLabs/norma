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
  TrustListParams, TrustRemoveParams, PluginRevokeTokenParams, PluginRestartParams,
  PluginRegisterParams, ToolRegisterParams, ShortcutRegisterParams, TileUpdateParams,
  ProviderRegisterParams, PluginsContribParams, PluginToolResultParams, HardwareRequestParams, HardwareRespondParams,
  SYSTEM_SESSION_ID,
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
import type { ToolRegistry } from "../agent/tools/registry";
import type { PluginSupervisor, PluginConn, InvokeError } from "../plugins/supervisor";
import type { PluginContribRegistry } from "../plugins/contrib";
import type { PeripheralBroker } from "../peripheral/broker";
import type { ProviderLink } from "../peripheral/provider-link";
import type { HardwareBroker } from "../peripheral/hardware";
import { verbClass } from "../peripheral/hardware";
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
  // Phase 4b Task 4 (spec §3): the plugin tool bridge. `registry` is the SAME ToolRegistry the
  // AgentEngine executes tool calls against (daemon.ts shares the one instance) — tool.register
  // registers `plugin__<pluginId>__<tool>` into it; the socket close() handler and the
  // supervisor's onCircuitOpen callback unregister a plugin's tools out of it. `supervisor`
  // brokers plugin.register/tool.register's bridged run()/plugin.toolResult against
  // PluginSupervisor (Task 3). `contrib` is latest-per-plugin storage for shortcut.register/
  // tile.update/provider.register (Phase 4d's read surface). `registry`/`supervisor` are normally
  // undefined together (no agentProvider ⇒ no ToolRegistry at all) — tool.register then throws a
  // typed RpcFailure rather than crashing; plugin.register/plugin.toolResult degrade to a bare
  // `{ok:true}` no-op (same precedent as `mcp`/`plans`/`tasks` above).
  registry?: ToolRegistry;
  supervisor?: PluginSupervisor;
  contrib?: PluginContribRegistry;
  questions?: QuestionBroker; // in-flight ask_user questions; ask_user.respond
  tasks?: TaskStore;         // session task lists; task.list
  plans?: PlanBroker;        // in-flight exit_plan_mode plans; plan.respond
  peripheral?: PeripheralBroker; // lease machinery; peripheral.* verbs (Phase 2f)
  providerLink?: ProviderLink;   // bridges PeripheralBroker.call()'s pushToProvider to the live
                                  // provider connection this server tracks (Phase 2f)
  // Phase 4c Task 2 (spec §5): plugin (or harness, dev/testing) → Norma.app's XPC helper.
  // `hardware` is constructed with the SAME `providerLink` as `peripheral` above (daemon.ts) — the
  // app's one provider connection doubles as the hardware provider. `hardware.respond` reuses
  // `peripheral.isProvider()` to gate on that SAME connection identity (see the hardware.respond
  // case below) rather than tracking its own.
  hardware?: HardwareBroker;
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
// these wire verbs — everything else (session.*, approval.*, peripheral.*, daemon.*, trust.*,
// plugins.*, ask_user.*, etc.) is role-rejected BEFORE dispatch, never reaching a handler. Task 4
// wires the original six handlers (plugin.register/tool.register/shortcut.register/tile.update/
// provider.register/plugin.toolResult) into PluginSupervisor + ToolRegistry + PluginContribRegistry
// below.
//
// Phase 4c Task 1 (spec §5) adds a seventh: `hardware.request` — a plugin's own tool may need to
// ask Norma.app's XPC helper to do something (e.g. set the battery charge limit). `hardware.respond`
// is DELIBERATELY NOT here: only the active provider connection (Norma.app) may answer a
// `hardware_requested` push, same precedent as `peripheral.respond` staying off this list — a
// plugin connection calling it is role-rejected before dispatch, never reaching the handler.
// Task 2 wires `hardware.request`'s handler (consent gate + HardwareBroker) below.
const PLUGIN_ALLOWED_METHODS = new Set<string>([
  METHODS.pluginRegister,
  METHODS.toolRegister,
  METHODS.shortcutRegister,
  METHODS.tileUpdate,
  METHODS.providerRegister,
  METHODS.pluginToolResult,
  METHODS.hardwareRequest,
]);

/** Maps a failed `PluginSupervisor.invoke()` result to the message a `throw new Error(...)` in
 *  `tool.register`'s bridged `run()` turns into an isError tool_result (ToolRegistry.execute's
 *  catch path) — see that handler below. */
function pluginInvokeErrorMessage(pluginId: string, tool: string, err: InvokeError): string {
  switch (err.code) {
    case "not_running": return `plugin ${pluginId} is not running`;
    case "no_connection": return `plugin ${pluginId} has no active connection`;
    case "timeout": return `plugin ${pluginId} tool ${tool} timed out`;
    case "crashed": return err.message;
    case "plugin_error": return err.message;
  }
}

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

  // Phase 4d Task 1 (spec §6/§7): a monotonic counter for `plugin_tile_updated`'s `seq` field.
  // `SessionStore.lastSeq(sessionId)` (what every OTHER transient event stamps itself with, e.g.
  // `SessionHub.broadcastTransient`) requires a REAL, already-created session row and throws
  // "unknown session" otherwise — there is no session backing `SYSTEM_SESSION_ID`, and minting a
  // fake one just to read a counter would be its own footgun (a phantom row in session.list).
  // NormaKit's dedupe gate is scoped to the currently ATTACHED session (`e.sessionId == attached`,
  // NormaClient.swift) and `$system` can never equal a real attached session id, so this event
  // always bypasses that gate regardless of its seq value — a locally-monotonic counter is
  // sufficient (schema-valid, ordered) without needing the store at all.
  let systemSeq = 0;

  /** Broadcasts `plugin_tile_updated` to every authed harness — modeled EXACTLY on the
   *  `session_created` broadcast above (same `harnessConns` set, same enqueue/encodeLine, same
   *  swallow-on-dead-socket): a dashboard connection is never attached to any session, so this
   *  goes out over the harness broadcast set rather than the per-session `SessionHub`. Reads the
   *  CURRENT tile straight out of the registry (rather than taking one as a parameter) so both
   *  call sites — `tile.update` (after `setTile`) and `close()` (after `clear`) — stay a single
   *  line each and can never drift from what `plugins.contrib` would return for the same plugin. */
  function broadcastTileUpdated(pluginId: string): void {
    const tile = opts.contrib?.get(pluginId)?.tile ?? null;
    const event = {
      type: "plugin_tile_updated" as const,
      sessionId: SYSTEM_SESSION_ID,
      seq: ++systemSeq,
      ts: Date.now(),
      pluginId,
      tile,
    };
    for (const conn of harnessConns) {
      try { conn.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })); }
      catch { /* dead socket — its close() handler will evict it from harnessConns */ }
    }
  }

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
        // Phase 4b Task 4: a plugin connection dropping (crash, SIGTERM, clean SDK shutdown, the
        // socket cap, anything) means every tool it registered can no longer be invoked —
        // unregister them FIRST (so a stale plugin__<id>__* tool never lingers in specs()/
        // ToolSearch even for the instant before notifyDisconnected's own backoff/circuit
        // bookkeeping runs), then tell the supervisor the connection is gone. notifyDisconnected
        // is an idempotent no-op outside status "running" (see its doc comment) — safe even for a
        // connection that never got past hello/plugin.register.
        if (socket.data.pluginId) {
          opts.registry?.unregisterByPrefix(`plugin__${socket.data.pluginId}__`);
          opts.supervisor?.notifyDisconnected(socket.data.pluginId);
          // Phase 4d Task 1: a disconnected plugin's shortcuts/tile/provider info is stale the
          // instant the connection drops (the SDK's serve() re-declares everything fresh on
          // reconnect, Task 5's contract) — clear it out of the registry, then broadcast so any
          // dashboard showing this plugin's tile drops the now-stale card (tile: null).
          opts.contrib?.clear(socket.data.pluginId);
          broadcastTileUpdated(socket.data.pluginId);
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
      // Hardware helper (Phase 4c Task 2, spec §5): plugin (or harness, dev/testing) → core →
      // Norma.app's XPC helper. Consent gating lives HERE, not in HardwareBroker — the broker has
      // no PluginStore access, only `verbClass` (this file's `hardware.request` case is the one
      // place that has BOTH the requesting plugin's PluginInfo and the verb's class at once). A
      // plugin-role caller must have the verb's class in its manifest's `permissions.hardware`
      // AND a "hardware" consent record on file; an unknown verb (`verbClass` returns null) skips
      // straight past this gate — the broker's own `request()` typed-rejects it as
      // `{code:"unknown_verb"}` (same check, reused, so a plugin can never learn "not consented"
      // for a verb that isn't even real). A harness (or admin) caller skips consent entirely —
      // dev/testing precedent, same as peripheral.lease's non-plugin paths — but is still audited,
      // as a `{kind:"harness"}` requester, by the broker itself.
      // -----------------------------------------------------------------------------------------
      case METHODS.hardwareRequest: {
        const p = parseParams(HardwareRequestParams, params);
        if (!opts.hardware) throw new RpcFailure(ERR.NOT_FOUND, "hardware broker unavailable");
        let requester: { kind: "plugin" | "harness"; id: string };
        if (socket.data.authedRole === "plugin") {
          const pluginId = socket.data.pluginId;
          if (!pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "hardware.request requires an authenticated plugin connection");
          requester = { kind: "plugin", id: pluginId };
          const cls = verbClass(p.verb);
          if (cls) {
            const info = opts.plugins?.list().find((pl) => pl.name === pluginId);
            if (!info?.hardwarePermissions.includes(cls)) {
              opts.hardware.auditDenied({ requester, verb: p.verb, code: "consent_denied", missing: cls });
              return { code: "consent_denied", missing: cls };
            }
            if (!info.consented.includes("hardware")) {
              opts.hardware.auditDenied({ requester, verb: p.verb, code: "consent_denied", missing: "hardware" });
              return { code: "consent_denied", missing: "hardware" };
            }
          }
        } else {
          requester = { kind: "harness", id: socket.data.clientName };
        }
        return await opts.hardware.request({ requester, verb: p.verb, argsJson: p.argsJson });
      }
      case METHODS.hardwareRespond: {
        const p = parseParams(HardwareRespondParams, params);
        if (!opts.peripheral?.isProvider(socket.data)) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "hardware.respond requires the active provider connection");
        }
        return opts.hardware?.respond({ requestId: p.requestId, resultJson: p.resultJson, error: p.error }) ?? { ok: true };
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

      // -----------------------------------------------------------------------------------------
      // plugin.restart (final-review Fix 1): the `PluginSupervisor.restart()` manual-restart rider
      // existed and was tested (supervisor.ts) but had no caller — this wires it up so `norma
      // plugin restart <id>` can recover a plugin stuck "circuit-open" (nothing else ever clears
      // that state short of a daemon restart). harness OR admin role, same precedent as
      // `plugins.list` above (no extra role check here) — NOT one of the six plugin-role verbs, so
      // a plugin connection never reaches this case at all (rejected by the allowlist gate first).
      // `configFor` looks up the spawn config the supervisor already has on record for a TRACKED
      // plugin (set at `startAll`/`reclaimOrphans`/an earlier `restart`) — a plugin id the
      // supervisor has never seen has nothing to restart FROM, so that's a typed NOT_FOUND rather
      // than silently no-op'ing.
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRestart: {
        const p = parseParams(PluginRestartParams, params);
        if (!opts.supervisor) throw new RpcFailure(ERR.INTERNAL, "plugin supervisor is not available on this server");
        const config = opts.supervisor.configFor(p.pluginId);
        if (!config) throw new RpcFailure(ERR.NOT_FOUND, `unknown plugin: ${p.pluginId}`);
        opts.supervisor.restart(config);
        return { ok: true };
      }

      // -----------------------------------------------------------------------------------------
      // Plugin tool bridge (Phase 4b Task 4, spec §3): wires the six plugin-role verbs (Task 1's
      // wire shapes, Task 2's role allowlist) into PluginSupervisor (Task 3) and the SAME
      // ToolRegistry the agent engine executes every other tool call against. The
      // PLUGIN_ALLOWED_METHODS gate above only RESTRICTS what a plugin-role connection may call —
      // it never widens who may call these, so a harness connection could technically reach these
      // cases too; each handler below still requires `socket.data.pluginId` itself (a
      // contribution/tool with no owning plugin id makes no sense), which only a plugin-role hello
      // ever sets.
      // -----------------------------------------------------------------------------------------
      case METHODS.pluginRegister: {
        const p = parseParams(PluginRegisterParams, params);
        // socket.data.pluginId is the id THIS connection actually authenticated as (hello,
        // verified against the sqlite-hashed plugin_tokens table) — authoritative over the wire
        // param. A mismatch means a plugin trying to register under an id it never authenticated
        // as; reject rather than silently trust `p.pluginId`.
        if (!socket.data.pluginId || p.pluginId !== socket.data.pluginId) {
          throw new RpcFailure(ERR.UNAUTHORIZED, "plugin.register: pluginId does not match the authenticated connection");
        }
        const conn: PluginConn = {
          push: (event) => socket.data.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: event })),
        };
        // The wire result is always {ok:true} (PluginRegisterResult has no room for a typed
        // rejection) regardless of whether the supervisor actually accepted the registration — a
        // late/duplicate/unexpected registration (notifyRegistered returns false) just means this
        // connection's tools, once registered, will never be invokable until a fresh spawn cycle
        // re-registers it; the plugin itself learns nothing different from a normal success.
        opts.supervisor?.notifyRegistered(socket.data.pluginId, conn);
        return { ok: true };
      }
      case METHODS.toolRegister: {
        const p = parseParams(ToolRegisterParams, params);
        const pluginId = socket.data.pluginId;
        if (!pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "tool.register requires an authenticated plugin connection");
        if (!opts.registry || !opts.supervisor) {
          throw new RpcFailure(ERR.INTERNAL, "plugin tool bridge is not available on this server");
        }
        const registry = opts.registry;
        const supervisor = opts.supervisor;
        const registeredAs = `plugin__${pluginId}__${p.name}`;
        try {
          registry.register({
            name: registeredAs,
            description: p.description,
            // The plugin author's raw JSON schema (or none) rides verbatim as rawParameters,
            // exactly like MCP's mcp/manager.ts#startOne — `args` is a permissive passthrough
            // since core never re-validates plugin-supplied argument shapes beyond "is an object"
            // (ToolRegisterParams.parameters's own doc comment, protocol/methods.ts).
            args: z.object({}).passthrough(),
            rawParameters: p.parameters,
            run: async (args) => {
              const result = await supervisor.invoke(pluginId, p.name, JSON.stringify(args));
              if ("ok" in result) return result.resultJson;
              // Throwing here is deliberate: ToolRegistry.execute's catch turns a thrown Error's
              // message into `{output: message, isError: true}` — the ONLY way a ToolDefinition's
              // `run()` (which returns a plain string) produces an isError tool_result.
              throw new Error(pluginInvokeErrorMessage(pluginId, p.name, result));
            },
          });
        } catch (e) {
          throw new RpcFailure(ERR.INVALID_REQUEST, (e as Error).message);
        }
        return { ok: true, registeredAs };
      }
      case METHODS.pluginToolResult: {
        const p = parseParams(PluginToolResultParams, params);
        // Final-review Fix 2: caller-bound — settle only goes through if THIS connection's own
        // authenticated pluginId (never a wire param) matches the pending invoke's pluginId. See
        // resolveToolResult's doc comment (plugins/supervisor.ts).
        return opts.supervisor?.resolveToolResult(p, socket.data.pluginId) ?? { ok: true };
      }
      case METHODS.shortcutRegister: {
        const p = parseParams(ShortcutRegisterParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "shortcut.register requires an authenticated plugin connection");
        opts.contrib?.setShortcuts(socket.data.pluginId, p.shortcuts);
        return { ok: true };
      }
      case METHODS.tileUpdate: {
        const p = parseParams(TileUpdateParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "tile.update requires an authenticated plugin connection");
        opts.contrib?.setTile(socket.data.pluginId, p.tile);
        broadcastTileUpdated(socket.data.pluginId);
        return { ok: true };
      }
      case METHODS.providerRegister: {
        const p = parseParams(ProviderRegisterParams, params);
        if (!socket.data.pluginId) throw new RpcFailure(ERR.UNAUTHORIZED, "provider.register requires an authenticated plugin connection");
        opts.contrib?.setProvider(socket.data.pluginId, p.info);
        return { ok: true };
      }
      case METHODS.pluginsContrib: {
        parseParams(PluginsContribParams, params);
        const entries = opts.contrib?.all().map(({ pluginId, state }) => ({ pluginId, ...state })) ?? [];
        return { ok: true, entries };
      }

      default:
        throw new RpcFailure(ERR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  return { stop() { server.stop(true); } };
}
