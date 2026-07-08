import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
import { acquireLock, type Lock } from "./lock";
import { TokenAuthority } from "./auth/tokens";
import { KeychainSecretStore, type SecretStore } from "./auth/secret-store";
import { SessionStore } from "./sessions/store";
import { SessionHub } from "./sessions/hub";
import { startIpcServer, type IpcServer, type IpcServerOptions } from "./ipc/server";
import { loadSettings, loadPermissionDirs } from "./settings";
import { createProvider } from "./providers/manager";
import type { Provider } from "./providers/types";
import { QuotaManager } from "./providers/quota";
import { ToolRegistry } from "./agent/tools/registry";
import { registerReadTools } from "./agent/tools/fs-read";
import { registerWriteTools } from "./agent/tools/fs-write";
import { registerBashTool } from "./agent/tools/bash";
import { registerRequestDirTool } from "./agent/tools/request-dir";
import { registerBackgroundTools } from "./agent/tools/background";
import { registerSkillTools } from "./agent/tools/skill";
import { registerToolSearchTool } from "./agent/tools/toolsearch";
import { registerAskUserTool } from "./agent/tools/ask-user";
import { registerTaskTools } from "./agent/tools/tasks";
import { registerPlanTool } from "./agent/tools/plan";
import { registerNotebookTool } from "./agent/tools/notebook";
import { registerWorktreeTools } from "./agent/tools/worktree";
import { registerSpawnAgentTool } from "./agent/tools/spawn";
import { McpManager } from "./agent/mcp/manager";
import { PermissionGate } from "./agent/gate";
import { ApprovalBroker } from "./agent/approvals";
import { QuestionBroker } from "./agent/questions";
import { TaskStore } from "./agent/task-store";
import { PlanBroker } from "./agent/plans";
import { WorktreeManager } from "./agent/worktree";
import { AgentStore } from "./agent/agents";
import { SubagentManager } from "./agent/subagents";
import { AgentEngine, SYSTEM_PROMPT } from "./agent/engine";
import { BashReviewer } from "./agent/reviewer";
import { SessionTitler } from "./agent/titles";
import { Compactor } from "./agent/compactor";
import { SessionDirectories } from "./agent/dirs";
import { TrustStore } from "./agent/trust";
import { ContextAssembler } from "./agent/context";
import { SkillStore } from "./agent/skills";
import { BackgroundTaskRegistry } from "./agent/bg-registry";
import { sessionTmpDir } from "./agent/session-tmp";
import { PluginStore } from "./agent/plugins";
import { AuditLog } from "./peripheral/audit";
import { PeripheralBroker, type PeripheralClass } from "./peripheral/broker";
import { ProviderLink } from "./peripheral/provider-link";
import type { NewSessionEvent } from "@norma/protocol";

export const CORE_VERSION = "0.0.1";

export interface RunningDaemon {
  socketPath: string;
  tokens: { harness: string; admin: string };
  stop(): void;
}

/** Builds the `policy(sessionId, cls)` dependency PeripheralBroker.lease() awaits (spec §A1:
 *  "lease acquisition FOLLOWS THE SESSION APPROVAL POLICY for ALL classes" — plan→denied,
 *  auto→granted, ask→a normal approval card). Reuses the SAME ApprovalBroker + approval_requested/
 *  approval_resolved/approval.respond machinery the agent engine's tool-call approvals use (no
 *  new wire method) — see engine.ts's `requestApproval` for the byte-identical
 *  wait-before-emit pattern this mirrors.
 *
 *  `cls` is now a plain call argument — PeripheralBroker.lease() passes `req.class` straight
 *  through, so the approval card's summary reads it off this closure's own parameter instead of
 *  a synchronous set/get side-channel (the former `peripheralClassHint` map) that only stayed
 *  race-safe because nothing ever awaited between the set and the card emit. */
function buildLeasePolicy(deps: {
  store: SessionStore;
  approvals: ApprovalBroker;
  hub: SessionHub;
  timeoutMs?: number;
}): (sessionId: string, cls: PeripheralClass) => Promise<"granted" | "denied"> {
  return async (sessionId: string, cls: PeripheralClass): Promise<"granted" | "denied"> => {
    let approvalPolicy: "ask" | "auto" | "plan";
    try {
      approvalPolicy = deps.store.meta(sessionId).approvalPolicy;
    } catch {
      return "denied"; // unknown session — fail closed (ipc/server.ts already validates first)
    }
    if (approvalPolicy === "plan") return "denied";
    if (approvalPolicy === "auto") return "granted";

    // ask: register the wait BEFORE emitting approval_requested (the append is synchronous, so a
    // watcher that resolves as soon as it observes the event would otherwise race broker.wait()).
    const callId = `lease_${randomBytes(6).toString("hex")}`;
    const waiting = deps.approvals.wait(sessionId, callId, deps.timeoutMs ?? 5 * 60_000);
    const event: NewSessionEvent = {
      type: "approval_requested", sessionId, threadId: "main", callId,
      toolName: "peripheral.lease", summary: `Session ${sessionId} requests ${cls}`,
    };
    try {
      deps.hub.append(sessionId, event);
    } catch (err) {
      deps.approvals.resolve(sessionId, callId, false, "emit-failure");
      throw err;
    }
    const res = await waiting;
    deps.hub.append(sessionId, {
      type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by,
    });
    return res.approved ? "granted" : "denied";
  };
}

export async function startDaemon(opts: {
  home?: string;
  secrets?: SecretStore;
  server?: Partial<Pick<IpcServerOptions, "helloTimeoutMs" | "maxConnections" | "preAuthMaxLine">>;
  /** undefined: try settings.json (production default). null: agent disabled (tests, Phase 0
   *  behavior). object: use this provider directly (tests inject FakeProvider). */
  agentProvider?: { provider: Provider; model: string } | null;
} = {}): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const dirs = bootstrapNormaDir(opts.home ?? resolveNormaHome());
  const lock: Lock = await acquireLock(dirs.lockPath, dirs.socketPath);

  const secrets = opts.secrets ?? new KeychainSecretStore();
  const authority = new TokenAuthority(secrets);
  const tokens = await authority.ensureTokens();

  const store = new SessionStore(dirs.home);
  const hub = new SessionHub(store);

  const normaHome = dirs.home;

  // Loaded once, up front, so the settings-derived plugin consent (below) is available before
  // the SkillStore and PluginStore are built. A malformed settings.json degrades to `null` here
  // — the agent gets disabled further down rather than crashing daemon startup.
  let settings: ReturnType<typeof loadSettings> | null;
  try {
    settings = loadSettings(dirs.settingsPath);
  } catch (err) {
    console.error(`settings unavailable, agent disabled: ${(err as Error).message}`);
    settings = null;
  }

  const trustStore = new TrustStore(join(normaHome, "trust.json"));
  const pluginStore = new PluginStore({ normaHome, plugins: settings?.plugins, log: (m) => console.error(m) });
  const skillStore = new SkillStore({ normaHome, trust: trustStore, plugins: { disabled: settings?.plugins?.disabled ?? [] } });
  const assembler = new ContextAssembler({ normaHome, trust: trustStore, skills: skillStore });
  // Built unconditionally (needs only store, no provider) so the server's session.addDir /
  // setCwd handlers always have live roots to work with, even when the agent is disabled.
  const sessionDirs = new SessionDirectories((sid) => {
    const m = store.meta(sid);
    return m.cwd ? [m.cwd, ...loadPermissionDirs(normaHome, m.cwd, trustStore.isTrusted(m.cwd))] : [];
  });

  // Built unconditionally (needs only store/sessionDirs, no provider) so background tasks
  // spawned before the agent is enabled (or during tests without a provider) still have a
  // registry to land in; the bg.* IPC handlers work regardless of agentProvider.
  const bgRegistry = new BackgroundTaskRegistry({
    emit: (sid, e) => hub.append(sid, e),
    spawnCtx: (sid) => {
      const m = store.meta(sid);
      return { cwd: m.cwd!, roots: sessionDirs.roots(sid), tmpDir: sessionTmpDir(sid) };
    },
  });

  // Unconditional (not gated on agentProvider): tool-call approvals need it only when the agent
  // is enabled, but peripheral lease acquisition (below) follows the SAME approval-broker
  // machinery under `ask` policy regardless of whether an LLM provider is configured — leasing is
  // an independent feature (spec §A1). An unused, empty broker behaves identically to the
  // previous `null` for approval.respond (nothing pending either way).
  const approvalBroker = new ApprovalBroker();

  let agentProvider = opts.agentProvider;
  let quota: QuotaManager | undefined;
  if (agentProvider === undefined) {
    if (settings) {
      try {
        const active = await createProvider(settings, secrets);
        agentProvider = { provider: active.provider, model: active.model };
        quota = active.quota;
      } catch (err) {
        console.error(`agent disabled: ${(err as Error).message}`);
        agentProvider = null;
      }
    } else {
      agentProvider = null;
    }
  }
  // Test-injected / disabled-agent paths never went through createProvider() (so never got a
  // real QuotaManager wrapping the provider) — quota.state() still needs SOMETHING to read, so
  // fall back to an inert manager that just reports the zero/ok defaults.
  quota ??= new QuotaManager();

  let engine: AgentEngine | null = null;
  let mcp: McpManager | null = null;
  let questions: QuestionBroker | null = null;
  let taskStore: TaskStore | null = null;
  let plans: PlanBroker | null = null;
  if (agentProvider) {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registerWriteTools(registry);
    registerBashTool(registry, { bgRegistry });
    registerBackgroundTools(registry, { bgRegistry });
    registerSkillTools(registry, { skills: skillStore });
    registerToolSearchTool(registry);
    questions = new QuestionBroker();
    taskStore = new TaskStore();
    registerAskUserTool(registry);
    registerTaskTools(registry, { tasks: taskStore });
    plans = new PlanBroker();
    registerPlanTool(registry);
    registerNotebookTool(registry);
    const worktrees = new WorktreeManager({ baseRef: settings?.worktree?.baseRef });
    registerWorktreeTools(registry);
    const agents = new AgentStore({ normaHome, trust: trustStore, baseInstructions: SYSTEM_PROMPT });
    const subagents = new SubagentManager({ maxConcurrent: settings?.subagents?.maxConcurrent });
    registerSpawnAgentTool(registry);
    mcp = new McpManager({ registry, trust: trustStore, log: (m) => console.error(m) });
    await mcp.startAll(settings?.mcpServers ?? {});
    // Plugin MCP servers start only with explicit settings consent (mcpEnabled = enabled && !disabled);
    // a plugin's skills are always live (SkillStore above), but its MCP servers are the seam that
    // needs the user opting in via settings.plugins.enabled.
    const enabledPlugins = pluginStore
      .list()
      .filter((p) => p.mcpEnabled && !p.disabled && p.hasMcp)
      .map((p) => ({ name: p.name, dir: join(normaHome, "plugins", p.name) }));
    await mcp.startPlugins(enabledPlugins);
    registerRequestDirTool(registry, {
      broker: approvalBroker,
      dirs: sessionDirs,
      emit: (sid, e) => hub.append(sid, e),
      projectDir: (sid) => store.meta(sid).cwd,
    });
    const compactor = new Compactor({ provider: agentProvider, store, hub });
    // Default ON: the reviewer is built unless settings.reviewer.enabled is explicitly false.
    const reviewerCfg = settings?.reviewer;
    const reviewer =
      reviewerCfg?.enabled === false ? undefined : new BashReviewer({ provider: agentProvider, model: reviewerCfg?.model });
    // Default ON: the titler is built unless settings.titles.enabled is explicitly false.
    const titlesCfg = settings?.titles;
    const titler =
      titlesCfg?.enabled === false ? undefined : new SessionTitler({ provider: agentProvider, store, hub, model: titlesCfg?.model });
    engine = new AgentEngine({
      store, hub, registry, broker: approvalBroker,
      gate: new PermissionGate(),
      dirs: sessionDirs,
      provider: agentProvider,
      assembler,
      compactor,
      mcp: mcp ?? undefined,
      questions: questions ?? undefined,
      tasks: taskStore ?? undefined,
      plans: plans ?? undefined,
      setPolicy: (sid, pol) => store.setApprovalPolicy(sid, pol),
      worktrees,
      agents,
      subagents,
      reviewer,
      reviewerEnabled: reviewerCfg?.enabled,
      reviewerAllow: reviewerCfg?.allow ?? [],
      titler,
      toolSearch: {
        enabled: settings?.toolSearch?.enabled,
        deferThreshold: settings?.toolSearch?.deferThreshold ?? Number(process.env.NORMA_TOOLSEARCH_THRESHOLD ?? 12),
      },
    });
  }

  // Peripheral lease v1 (Phase 2f). Built unconditionally (like approvalBroker/quota above) —
  // leasing has nothing to do with whether an LLM provider is configured.
  const audit = new AuditLog(join(normaHome, "audit.jsonl"));
  const providerLink = new ProviderLink();
  const peripheral = new PeripheralBroker({
    audit,
    heartbeatMs: settings?.peripheral?.heartbeatMs,
    expiryMs: settings?.peripheral?.expiryMs,
    policy: buildLeasePolicy({ store, approvals: approvalBroker, hub }),
    // lease_granted/lease_lost are emitted on the REQUESTER's session (broadcastTransient scopes
    // fan-out to that session's attached harnesses), but the provider connection (Norma.app) is
    // rarely attached to the requesting session — it needs its own copy of these two event types
    // to track its active-lease set regardless of what it's attached to. peripheral_call_requested
    // already reaches the provider via pushToProvider; lease_granted/lease_lost did not, which
    // would have left the provider's lease-tracking silently blind whenever it wasn't attached to
    // the leasing session. Pushed in addition to (not instead of) the session broadcast.
    emitTransient: (sessionId, event) => {
      hub.broadcastTransient(sessionId, event);
      if (event.type === "lease_granted" || event.type === "lease_lost") providerLink.push(event);
    },
    pushToProvider: (event) => providerLink.push(event),
  });

  const providerInfo = agentProvider ? { id: agentProvider.provider.id, model: agentProvider.model } : null;

  const server: IpcServer = startIpcServer({
    socketPath: dirs.socketPath,
    serverVersion: CORE_VERSION,
    tokens: authority,
    store,
    hub,
    engine,
    broker: approvalBroker,
    dirs: sessionDirs,
    trust: trustStore,
    bg: bgRegistry,
    skills: skillStore,
    plugins: pluginStore,
    mcp: mcp ?? undefined,
    questions: questions ?? undefined,
    tasks: taskStore ?? undefined,
    plans: plans ?? undefined,
    peripheral,
    providerLink,
    quota,
    providerInfo,
    startedAt,
    ...opts.server,
  });

  console.error(`norma-core ${CORE_VERSION} listening on ${dirs.socketPath}`);
  return {
    socketPath: dirs.socketPath,
    tokens,
    stop() { server.stop(); mcp?.stopAll(); bgRegistry.killAll(); store.close(); lock.release(); },
  };
}

// Direct execution: `bun run src/daemon.ts` (also the compiled binary's `daemon run` path).
if (import.meta.main) {
  const daemon = await startDaemon();
  const shutdown = () => { daemon.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
