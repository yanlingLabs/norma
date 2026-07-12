import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
import { acquireLock, type Lock } from "./lock";
import { TokenAuthority } from "./auth/tokens";
import { KeychainSecretStore, type SecretStore } from "./auth/secret-store";
import { SessionStore } from "./sessions/store";
import { SessionHub } from "./sessions/hub";
import { startIpcServer, type IpcServer, type IpcServerOptions } from "./ipc/server";
import { loadSettings, loadPermissionDirs, hooksEnabledFrom } from "./settings";
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
import { registerSendMessageTool } from "./agent/tools/send-message";
import { registerTaskStopTool } from "./agent/tools/task-stop";
import { registerScheduleTool } from "./agent/tools/schedule";
import { registerWebTools } from "./agent/tools/web";
import { registerComputerTool } from "./agent/tools/computer";
import { ComputerUseService } from "./agent/computer-use";
import { McpManager } from "./agent/mcp/manager";
import { PermissionGate } from "./agent/gate";
import { ApprovalBroker } from "./agent/approvals";
import { QuestionBroker } from "./agent/questions";
import { TaskStore } from "./agent/task-store";
import { PlanBroker } from "./agent/plans";
import { WorktreeManager } from "./agent/worktree";
import { AgentStore } from "./agent/agents";
import { SubagentManager } from "./agent/subagents";
import { BackgroundAgentRegistry } from "./agent/bg-agent-registry";
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
import { PluginStore, pluginMcpEligible, pluginSpawnEligible, hookRegistryPlugins } from "./agent/plugins";
import { PluginSupervisor } from "./plugins/supervisor";
import { PluginContribRegistry } from "./plugins/contrib";
import { HookRegistry, HookFacade } from "./plugins/hook-registry";
import { HookRunner } from "./plugins/hook-runner";
import { AuditLog } from "./peripheral/audit";
import { PeripheralBroker, type PeripheralClass } from "./peripheral/broker";
import { ProviderLink } from "./peripheral/provider-link";
import { HardwareBroker } from "./peripheral/hardware";
import { openRoutineStore } from "./routines/store";
import { RoutineAuditLog } from "./routines/audit";
import { makeDaemonRoutineRunner } from "./routines/runner";
import { makeRoutineScheduler } from "./routines/scheduler";
import type { NewSessionEvent } from "@norma/protocol";

export const CORE_VERSION = "0.0.1";

export interface RunningDaemon {
  socketPath: string;
  tokens: { harness: string; admin: string };
  stop(): void;
}

/** Same mtime-or-zero helper providers/manager.ts's `liveModel` and ipc/server.ts's `livePlugins`
 *  each already define locally — kept as a tiny module-private duplicate here too rather than
 *  exported/shared, matching that existing precedent (no shared "settings hot-read" utility file
 *  exists yet; each hot-read site owns its own cache). */
function statMtimeOrZero(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; } // missing file -> key 0
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
      // COUPLING (4h-i, refined 4h-ii-a): this reads the PERSISTED session policy as a proxy for
      // "the current caller's policy". That's safe because peripheral.lease is a harness-only RPC
      // (ipc/server.ts line 654), NEVER registered as an agent tool — so NO thread (main or
      // subagent, sync or async/4h-ii) can ever reach it from a tool call. If a thread-correlated
      // lease path is ever added to the registry in the future, gate approval on the calling
      // thread's policy (opts.threadId, or a thread_policy map), not the persisted session policy.
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
   *  behavior). object: use this provider directly (tests inject FakeProvider). `live`, when
   *  present, is threaded into EngineConfig.provider.live (no-restart model resolution) — tests
   *  that inject a provider directly and don't care about live resolution just omit it. */
  agentProvider?: { provider: Provider; model: string; live?: () => { model: string; reasoningEffort?: string } } | null;
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
  const pluginStore = new PluginStore({
    normaHome, plugins: settings?.plugins, consents: settings?.plugins?.consents, log: (m) => console.error(m),
  });
  // Built unconditionally (Phase 4b Task 4): shortcut.register/tile.update/provider.register are
  // plain latest-per-plugin storage, independent of whether an LLM provider (and thus a
  // ToolRegistry/PluginSupervisor) exists — a plugin process started outside the supervisor (e.g.
  // manually, for development) can still register contributions over a plain plugin-role hello.
  const pluginContrib = new PluginContribRegistry();
  // Plugin hooks runtime (Phase 4f Task 2): the registry itself is built unconditionally, same
  // precedent as `pluginContrib` above — it's cheap in-memory state, independent of whether an LLM
  // provider is configured. Rebuilt below (once `allPlugins` exists) at boot, and again by
  // ipc/server.ts's plugin.enable/disable/remove/setConsent handlers via the SAME instance (passed
  // through startIpcServer's opts) — mirroring how `contributes.mcpServers` attaches at scan time,
  // but ALSO hot-rebuilt on lifecycle changes (unlike MCP servers today), matching Tier-2's
  // hotApplyStart/hotApplyStop precedent for "no restart needed" plugin changes.
  const hookRegistry = new HookRegistry();
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
        const active = await createProvider(settings, secrets, dirs.settingsPath);
        // `model` here is the RESOLVED (not raw) boot selection — active.model is the raw
        // settings.json value, which for codex-oauth may be a since-deprecated slug (e.g.
        // "gpt-5.4"). Everything that consumes this snapshot directly rather than calling `live`
        // per-turn (Compactor's own summarization turn, BashReviewer, SessionTitler, the
        // daemon-status `providerInfo` below) needs a model the backend will actually accept, so
        // resolve once here via the SAME deprecation-fallback path `live` uses on every turn.
        // `live` itself is still wired separately below (EngineConfig.provider.live) so turns
        // keep re-resolving on every call, not just at this boot snapshot.
        agentProvider = { provider: active.provider, model: active.liveModel().model, live: active.liveModel };
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
  // ipc/server.ts (Phase 4b Task 4) needs the SAME ToolRegistry instance the engine executes tool
  // calls against, to register/unregister `plugin__<id>__<tool>` tools — but startIpcServer() is
  // called OUTSIDE the `if (agentProvider)` block below, where the registry is constructed.
  // Mirrored into this outer binding right after construction rather than hoisting the `const`
  // itself, so every existing narrowed (non-null) use of `registry` inside the block is untouched.
  let sharedRegistry: ToolRegistry | null = null;

  // Phase 4d-cleanup Task 2: PluginSupervisor construction + the boot-time orphan-PID sweep are
  // hoisted OUT of `if (agentProvider)` below — the ctor's own deps (runDir/socketPath/mintToken/
  // settings/logger) don't need a provider, and a daemon booted with the agent disabled (no
  // provider configured, or a test that injects `agentProvider: null`) should still reclaim/clean
  // up stale <runDir>/plugins/<id>.pid files left by a PREVIOUS run instead of leaving them
  // orphaned indefinitely — until, if ever, a provider happens to become configured. `startAll(...)`
  // — the part that actually spawns spawn-eligible plugins as live agent tools — STAYS inside the
  // gate below (a plugin process spawned with no engine/registry to bridge its tools into would be
  // pointless). `onCircuitOpen` closes over the OUTER `sharedRegistry` binding (not the gate-local
  // `registry` const, which isn't in scope here) so it keeps behaving correctly either way — a safe
  // no-op via optional chaining while `sharedRegistry` is still null (no provider).
  const allPlugins = pluginStore.list();
  // Boot-time hook-registry build (Phase 4f Task 2) — the SAME eligible-plugin projection
  // (`hookRegistryPlugins`, agent/plugins.ts) ipc/server.ts's lifecycle RPCs use to rebuild this
  // SAME `hookRegistry` instance hot, later, off a fresh `livePlugins()` read.
  hookRegistry.rebuild(hookRegistryPlugins(allPlugins, normaHome));
  const pluginSupervisor = new PluginSupervisor({
    runDir: dirs.runDir,
    socketPath: dirs.socketPath,
    mintToken: (id) => store.mintPluginToken(id),
    settings: settings?.plugins?.supervisor,
    onLog: (m) => console.error(m),
    onCircuitOpen: (id) => sharedRegistry?.unregisterByPrefix(`plugin__${id}__`),
  });
  const spawnablePlugins = allPlugins
    .filter(pluginSpawnEligible)
    .map((p) => ({ id: p.name, dir: join(normaHome, "plugins", p.name), entry: p.entry! }));
  // Phase 4d-i Task 4: boot-time orphan-PID sweep, BEFORE startAll spawns the current set — a
  // plugin disabled or removed since the last run may have left its process running under a
  // stale <runDir>/plugins/<id>.pid; startAll/reclaimOrphans would never find it (they only look
  // at PID files for plugins in `spawnablePlugins`), so this sweeps the FULL PID-file directory
  // and cleans up anything not in the currently spawn-eligible set (verified via the same
  // ps-lstart identity check, fail-safe no-kill on any mismatch — see sweepOrphans's doc comment).
  // Runs regardless of agentProvider (see this block's own doc comment above).
  pluginSupervisor.sweepOrphans(spawnablePlugins.map((p) => p.id));

  // Hoisted above the `if (agentProvider)` gate (4g Task 5) — registerWebTools below needs it, and
  // tool registration happens inside that gate. Built unconditionally regardless (same precedent as
  // `peripheral`/`hardware` further down, which share this SAME instance): normaHome is ready at
  // line 135, and AuditLog's own constructor is cheap (mkdir is lazy, on first write — see audit.ts).
  const audit = new AuditLog(join(normaHome, "audit.jsonl"));

  // Peripheral lease v1 (Phase 2f) — HOISTED above the `if (agentProvider)` gate (phase 5 CU): the
  // ComputerUseService (built inside the gate) needs this broker to lease screenshot/ax-read/input-
  // drive in-process, and the `computer` tool is registered inside the gate. Construction only needs
  // audit/store/approvalBroker/hub, all ready above — same "build unconditionally, leasing is
  // independent of an LLM provider" rationale it had further down. `hardware` (which shares this
  // SAME providerLink) stays below; it only references providerLink, which is now in scope earlier.
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
  // Phase 5 routines T3: hoisted above the `if (agentProvider)` gate for the SAME reason as `audit`
  // just above — the `schedule` tool (registered inside that gate, alongside every other built-in
  // tool) needs the store, but the rest of the routines subsystem (audit log/runner/scheduler,
  // below, past the gate's closing brace) needs `engine`, which isn't settled until the gate
  // closes. Splitting the construction this way means there is still only ONE RoutineStore
  // instance for the whole daemon (no risk of the tool and the scheduler racing on two separate
  // sqlite handles to the same file) — see the "Scheduled routines" block below, which reuses this
  // SAME `routineStore` rather than calling `openRoutineStore` a second time.
  const routineStore = openRoutineStore(join(normaHome, "routines.db"));

  if (agentProvider) {
    const registry = new ToolRegistry();
    sharedRegistry = registry;
    registerReadTools(registry);
    registerWriteTools(registry);
    registerBashTool(registry, { bgRegistry }); // bash itself is NEVER deferred — only its background-poll pair below
    registerBackgroundTools(registry, { bgRegistry }, { deferred: true });
    registerSkillTools(registry, { skills: skillStore });
    registerToolSearchTool(registry);
    questions = new QuestionBroker();
    taskStore = new TaskStore();
    registerAskUserTool(registry);
    registerTaskTools(registry, { tasks: taskStore });
    plans = new PlanBroker();
    registerPlanTool(registry, { deferred: true });
    registerNotebookTool(registry, { deferred: true });
    const worktrees = new WorktreeManager({ baseRef: settings?.worktree?.baseRef });
    registerWorktreeTools(registry, { deferred: true });
    // 4g Task 5: web_fetch — Norma's ONLY sanctioned network egress (bash's sandbox denies network
    // by design). Shares the SAME `audit` appender instance as peripheral/hardware below (hoisted
    // above this gate for exactly this reason) — every call (success, ssrf-refusal, http error,
    // timeout) gets one `{kind:"network", tool:"web_fetch", url, outcome}` line on audit.jsonl.
    // 4g Task 6: web_search's Brave API key rides the SAME `secrets` store (KeychainSecretStore,
    // built at the top of startDaemon) `norma login --web-search-key` writes into — one
    // SecretStore instance, one Keychain, no separate store to keep in sync.
    registerWebTools(registry, { audit: (line) => audit.append(line), secret: (name) => secrets.get(name) });
    const agents = new AgentStore({
      normaHome, trust: trustStore, baseInstructions: SYSTEM_PROMPT,
      plugins: { disabled: settings?.plugins?.disabled ?? [] },
    });
    const subagents = new SubagentManager({ maxConcurrent: settings?.subagents?.maxConcurrent });
    // Async spawn (4h-ii-a): tracks DETACHED (`run_in_background:true`) child threads — see
    // bg-agent-registry.ts's own doc comment for why this is separate from `bgRegistry` above
    // (that one owns backgrounded bash processes; this one owns agent threads). Built
    // unconditionally alongside `subagents` — both are required together for the spawn bridge's
    // async branch to activate (engine.ts's EngineConfig.bgAgents doc comment).
    const bgAgents = new BackgroundAgentRegistry();
    // `agentProvider` is already narrowed non-null here (we're inside `if (agentProvider)`), and
    // its `.provider` is the SAME provider instance the engine's spawn bridge calls .models() on
    // to validate a spawn_agent model override (4e gate F9) — so this list is exactly what the
    // bridge will accept. Empty (an openai-compatible provider with no static `models` configured)
    // → registerSpawnAgentTool falls back to its generic "model: optional model override" wording.
    registerSpawnAgentTool(registry, { models: agentProvider.provider.models().map((m) => m.id) });
    // 4h-ii-b Task 4 (CC SendMessage): registered alongside spawn_agent (only when subagents are
    // available) so the MAIN thread can address a subagent by agentId/name — a running one gets the
    // message at its next step, a finished one is resumed with it. Like spawn_agent it's an engine
    // bridge; this DEF is what the model sees, the engine intercepts the call (see engine.ts's
    // sendMessageCalls bridge). Excluded from every child's tool set (depth-0 only).
    registerSendMessageTool(registry);
    // 4h-ii-c Task 2 (CC TaskStop): registered alongside spawn_agent/send_message — the SAME
    // `bgAgents`/`bgRegistry` instances the engine cfg gets below, so a stop here is visible to
    // the engine's own pin/completion-reminder bookkeeping. Unlike spawn_agent/send_message this
    // is a PLAIN TOOL (no engine bridge — see task-stop.ts's own doc comment), deferred like
    // bash_kill (registerBackgroundTools above).
    registerTaskStopTool(registry, { bgAgents, bgRegistry, deferred: true });
    // Computer use (Phase 5 CU): opt-in via settings.computerUse.enabled (the strongest reading of
    // "full-auto CU requires explicit opt-in" — absent/false, the `computer` tool does not exist).
    // The service holds leases on the SAME `peripheral` broker (hoisted above this gate) that
    // Norma.app serves screenshot/ax-read/input-drive behind. reuses settings.peripheral.heartbeatMs.
    let computerUse: ComputerUseService | undefined;
    if (settings?.computerUse?.enabled) {
      computerUse = new ComputerUseService({ broker: peripheral, heartbeatMs: settings?.peripheral?.heartbeatMs });
      registerComputerTool(registry, { screenshotMaxDim: settings?.computerUse?.screenshotMaxDim });
    }
    // Phase 5 routines T3 (design doc §4): the agent-facing management surface over the SAME
    // `routineStore` instance the scheduler (below, past this gate's close) fires against —
    // `routineStore` is hoisted above this gate for exactly this sharing (see its own doc comment).
    // Deferred like worktree/notebook/plan above — a specialized tool, not needed in every turn.
    registerScheduleTool(registry, { routines: routineStore }, { deferred: true });
    mcp = new McpManager({ registry, trust: trustStore, log: (m) => console.error(m) });
    await mcp.startAll(settings?.mcpServers ?? {});
    // Plugin MCP servers start only with explicit settings consent (mcpEnabled = enabled &&
    // !disabled); a plugin's skills are always live (SkillStore above), but its MCP/manifest
    // content is the seam that needs the user opting in via settings.plugins.enabled AND,
    // per-exec-class, a settings.plugins.consents record (pluginMcpEligible in agent/plugins.ts —
    // legacy plugins have requiredConsents [] so this is unchanged for them; a manifest plugin
    // with exec content that's enabled but unconsented is excluded here, logged below). The
    // `!pluginMcpEligible(p)` on the right is the SAME eligibility predicate the enabledPlugins
    // filter below uses — deriving it inline (e.g. hand-rolling !consentComplete(p)) would let the
    // why-log drift out of sync with what actually gates MCP start; the left-hand guard just
    // narrows the log to the "would be eligible if not for consent" case so we don't log for
    // plugins that were never enabled or never carried MCP content in the first place.
    for (const p of allPlugins) {
      if (p.mcpEnabled && !p.disabled && (p.hasMcp || p.hasManifestMcp) && !pluginMcpEligible(p)) {
        const missing = p.requiredConsents.filter((c) => !p.consented.includes(c));
        console.error(`plugin ${p.name}: enabled but missing consent for ${missing.join(", ")} — MCP not started`);
      }
    }
    // manifestServers (Task 4, spec §2: "mcpServers may now come from the manifest instead of
    // .mcp.json ... manifest wins on conflict") comes straight off PluginInfo — PluginStore.list()
    // already ran loadManifest once per plugin and carried contributes.mcpServers through as
    // p.manifestServers (undefined for legacy plugins and manifest plugins with no mcpServers
    // declared). Re-reading norma-plugin.json here would risk a manifest that read fine moments
    // ago (hasManifestMcp true, gating eligibility) but fails to reparse on a second read —
    // silently falling back to the legacy .mcp.json path without ever disclosing that switch.
    const enabledPlugins = allPlugins
      .filter(pluginMcpEligible)
      .map((p) => ({ name: p.name, dir: join(normaHome, "plugins", p.name), manifestServers: p.manifestServers }));
    await mcp.startPlugins(enabledPlugins);

    // Tier-2 platform plugins (Phase 4b Task 3, spec §3): PluginSupervisor owns process lifecycle
    // (spawn/registration timeout/crash backoff/circuit breaker/PID-file orphan reclaim) for every
    // spawn-eligible plugin (pluginSpawnEligible — tier "platform" + entry present + enabled +
    // consented, the same enabled/disabled/consent shape as pluginMcpEligible above). `pluginSupervisor`/
    // `spawnablePlugins` are constructed above, OUTSIDE this gate (Phase 4d-cleanup Task 2 — the
    // orphan sweep runs regardless of agentProvider); only the actual spawn — `startAll()` — is
    // gated here, since a spawned plugin process needs `registry` (just below) to bridge its tools
    // into. startAll() is non-blocking (orphan reclaim/registration waits are timer-driven, never
    // awaited here). Task 4 wires the actual tool.register/plugin_tool_invoke bridge into `registry`
    // and the ipc handlers that call notifyRegistered/notifyDisconnected/resolveToolResult.
    // `onCircuitOpen` (wired at construction, above) is Task 4's other half of that wiring: when the
    // breaker trips, this plugin's process is done until a manual restart — its `plugin__<id>__*`
    // tools must stop being offered to the agent, so it unregisters them straight out of the SAME
    // registry `registerReadTools` etc. above populated (via the `sharedRegistry` mirror, since
    // `onCircuitOpen` was wired before `registry` existed).
    pluginSupervisor.startAll(spawnablePlugins);

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
    // Plugin hooks runtime (Phase 4f Task 2): the engine-facing `cfg.hooks` facade. `hookRegistry`
    // is the SAME instance ipc/server.ts's plugin-lifecycle RPCs rebuild in place (passed through
    // startIpcServer's opts below), so a `plugin.enable`/`disable` hot-apply is visible to the
    // facade with no daemon restart. `hooksEnabledHot` mirrors providers/manager.ts's `liveModel`
    // pattern (mtime-cached settings.json re-read per call, never throwing — falls back to the
    // spec default of enabled) rather than closing over the boot-time `settings` snapshot above,
    // so `hooks.enabled` toggles live too, exactly like the plan's "read like other hot settings".
    let hooksEnabledCache: { key: number; value: boolean } | null = null;
    const hooksEnabledHot = (): boolean => {
      const key = statMtimeOrZero(dirs.settingsPath);
      if (hooksEnabledCache && hooksEnabledCache.key === key) return hooksEnabledCache.value;
      let value: boolean;
      try {
        value = hooksEnabledFrom(loadSettings(dirs.settingsPath));
      } catch {
        value = true; // never throw into a hook call — same fail-open-on-read-failure precedent as liveModel
      }
      hooksEnabledCache = { key, value };
      return value;
    };
    const hookFacade = new HookFacade({ registry: hookRegistry, runner: new HookRunner(), hooksEnabled: hooksEnabledHot });
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
      bgRegistry,
      agents,
      subagents,
      bgAgents,
      // 4h-i Task 3: undefined (settings.subagents.maxDepth unset) → engine.ts's runThread
      // defaults it to 2 itself (`subagentMaxDepth ?? 2`) — mirrors the maxConcurrent line above,
      // which leans on SubagentManager's own internal default the same way.
      subagentMaxDepth: settings?.subagents?.maxDepth,
      reviewer,
      reviewerEnabled: reviewerCfg?.enabled,
      reviewerAllow: reviewerCfg?.allow ?? [],
      titler,
      computerUse,
      toolSearch: {
        enabled: settings?.toolSearch?.enabled,
        deferThreshold: settings?.toolSearch?.deferThreshold ?? Number(process.env.NORMA_TOOLSEARCH_THRESHOLD ?? 12),
        deferExternals: settings?.toolSearch?.deferExternals,
      },
      hooks: hookFacade,
    });
  }

  // Scheduled routines (Phase 5 T2, design doc §2; `routineStore` itself hoisted above the
  // `if (agentProvider)` gate in T3 — see its own doc comment). Built unconditionally (same
  // precedent as peripheral/hardware below) — a no-provider daemon still owns the store/audit so
  // `routines.*` RPCs (T3) work and existing routines aren't silently dropped; `engine` being null
  // just makes every fire fail cleanly via runHeadless's own "agent disabled" short-circuit (below
  // `engine` is ALREADY its final value — this sits after the `if (agentProvider)` block closes,
  // never reassigned again — so no thunk/live-read indirection is needed here, unlike
  // hooksEnabledHot's mtime-cached settings re-read, which exists for a genuinely different
  // reason: hot-reloading a boolean without a restart). `routines.maxConcurrent` is a boot-time
  // settings snapshot (the SAME precedent as `subagents.maxConcurrent` above — not hot-reloaded; a
  // live "no restart needed" override wasn't asked for here the way it was for `hooks.enabled`).
  const routinesAudit = new RoutineAuditLog(join(normaHome, "routines-audit.jsonl"));
  const routineRunner = makeDaemonRoutineRunner({ store, hub, engine });
  const routineScheduler = makeRoutineScheduler({
    store: routineStore,
    runner: routineRunner,
    audit: (line) => routinesAudit.append(line),
    maxConcurrent: () => settings?.routines?.maxConcurrent,
  });
  routineScheduler.start();

  // Peripheral lease v1 (Phase 2f): `providerLink`/`peripheral` are constructed ABOVE the
  // `if (agentProvider)` gate (phase 5 CU hoist — see that block); reused here.

  // Hardware helper (Phase 4c Task 2, spec §5).  // Hardware helper (Phase 4c Task 2, spec §5). Built unconditionally, same precedent as
  // `peripheral` above — hardware access has nothing to do with whether an LLM provider is
  // configured. Shares the SAME `providerLink`/`audit` instances as `peripheral`: Norma.app's one
  // provider connection doubles as the hardware provider, and `hardware.respond` (ipc/server.ts)
  // reuses `peripheral.isProvider()` to gate on that SAME connection identity rather than tracking
  // its own.
  const hardware = new HardwareBroker({ audit, pushToProvider: (event) => providerLink.push(event) });

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
    // Phase 4d-ii Task 2: lets the plugin-lifecycle RPCs (plugins.install/plugin.enable/disable/
    // remove/setConsent) read+write settings.json and the plugins directory directly, and re-read
    // both fresh on every call (`livePlugins`, ipc/server.ts) instead of trusting `pluginStore`
    // above's boot-time snapshot.
    normaHome,
    mcp: mcp ?? undefined,
    // Phase 4b Task 4: the plugin tool bridge. `registry` is undefined whenever agentProvider is
    // null (see `sharedRegistry`'s doc comment above). `supervisor`, unlike `registry`, is now
    // ALWAYS defined (Phase 4d-cleanup Task 2 hoisted its construction out of the agentProvider
    // gate — its orphan-sweep duties don't need a provider) — ipc/server.ts's handlers that need
    // BOTH together (e.g. `tool.register`) still gate correctly since they check `opts.registry`
    // explicitly, not `opts.supervisor`'s presence as a proxy for it. `contrib` is always available.
    registry: sharedRegistry ?? undefined,
    supervisor: pluginSupervisor,
    contrib: pluginContrib,
    // Phase 4f Task 2: the SAME HookRegistry instance the engine's `cfg.hooks` facade (above,
    // inside the agentProvider gate) reads from — lets plugin.enable/disable/remove/setConsent
    // rebuild it hot (mirroring hotApplyStart/hotApplyStop's Tier-2 precedent), with no daemon
    // restart, even on a no-provider daemon where the facade itself was never built.
    hooks: hookRegistry,
    questions: questions ?? undefined,
    tasks: taskStore ?? undefined,
    plans: plans ?? undefined,
    peripheral,
    providerLink,
    hardware,
    quota,
    providerInfo,
    startedAt,
    // Phase 5 routines T3: same RoutineStore instance the `schedule` tool (inside the
    // `if (agentProvider)` gate above) and the scheduler (constructed just above this call) both
    // share — one sqlite handle for the whole daemon.
    routines: routineStore,
    ...opts.server,
  });

  console.error(`norma-core ${CORE_VERSION} listening on ${dirs.socketPath}`);
  return {
    socketPath: dirs.socketPath,
    tokens,
    stop() {
      server.stop(); mcp?.stopAll(); pluginSupervisor.stopAll(); bgRegistry.killAll();
      routineScheduler.stop(); routineStore.close(); // no orphan tick timer past drain
      store.close(); lock.release();
    },
  };
}

// Direct execution: `bun run src/daemon.ts` (also the compiled binary's `daemon run` path).
if (import.meta.main) {
  const daemon = await startDaemon();
  const shutdown = () => { daemon.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
