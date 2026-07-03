import { join } from "node:path";
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
import { ToolRegistry } from "./agent/tools/registry";
import { registerReadTools } from "./agent/tools/fs-read";
import { registerWriteTools } from "./agent/tools/fs-write";
import { registerBashTool } from "./agent/tools/bash";
import { registerRequestDirTool } from "./agent/tools/request-dir";
import { registerBackgroundTools } from "./agent/tools/background";
import { registerSkillTools } from "./agent/tools/skill";
import { McpManager } from "./agent/mcp/manager";
import { PermissionGate } from "./agent/gate";
import { ApprovalBroker } from "./agent/approvals";
import { AgentEngine } from "./agent/engine";
import { Compactor } from "./agent/compactor";
import { SessionDirectories } from "./agent/dirs";
import { TrustStore } from "./agent/trust";
import { ContextAssembler } from "./agent/context";
import { SkillStore } from "./agent/skills";
import { BackgroundTaskRegistry } from "./agent/bg-registry";
import { sessionTmpDir } from "./agent/session-tmp";

export const CORE_VERSION = "0.0.1";

export interface RunningDaemon {
  socketPath: string;
  tokens: { harness: string; admin: string };
  stop(): void;
}

export async function startDaemon(opts: {
  home?: string;
  secrets?: SecretStore;
  server?: Partial<Pick<IpcServerOptions, "helloTimeoutMs" | "maxConnections" | "preAuthMaxLine">>;
  /** undefined: try settings.json (production default). null: agent disabled (tests, Phase 0
   *  behavior). object: use this provider directly (tests inject FakeProvider). */
  agentProvider?: { provider: Provider; model: string } | null;
} = {}): Promise<RunningDaemon> {
  const dirs = bootstrapNormaDir(opts.home ?? resolveNormaHome());
  const lock: Lock = await acquireLock(dirs.lockPath, dirs.socketPath);

  const secrets = opts.secrets ?? new KeychainSecretStore();
  const authority = new TokenAuthority(secrets);
  const tokens = await authority.ensureTokens();

  const store = new SessionStore(dirs.home);
  const hub = new SessionHub(store);

  const normaHome = dirs.home;
  const trustStore = new TrustStore(join(normaHome, "trust.json"));
  const skillStore = new SkillStore({ normaHome, trust: trustStore });
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

  let agentProvider = opts.agentProvider;
  if (agentProvider === undefined) {
    try {
      const settings = loadSettings(dirs.settingsPath);
      const active = await createProvider(settings, secrets);
      agentProvider = { provider: active.provider, model: active.model };
    } catch (err) {
      console.error(`agent disabled: ${(err as Error).message}`);
      agentProvider = null;
    }
  }

  let engine: AgentEngine | null = null;
  let broker: ApprovalBroker | null = null;
  let mcp: McpManager | null = null;
  if (agentProvider) {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registerWriteTools(registry);
    registerBashTool(registry, { bgRegistry });
    registerBackgroundTools(registry, { bgRegistry });
    registerSkillTools(registry, { skills: skillStore });
    mcp = new McpManager({ registry, log: (m) => console.error(m) });
    await mcp.startAll(loadSettings(dirs.settingsPath).mcpServers ?? {});
    broker = new ApprovalBroker();
    registerRequestDirTool(registry, {
      broker,
      dirs: sessionDirs,
      emit: (sid, e) => hub.append(sid, e),
      projectDir: (sid) => store.meta(sid).cwd,
    });
    const compactor = new Compactor({ provider: agentProvider, store, hub });
    engine = new AgentEngine({
      store, hub, registry, broker,
      gate: new PermissionGate(),
      dirs: sessionDirs,
      provider: agentProvider,
      assembler,
      compactor,
    });
  }

  const server: IpcServer = startIpcServer({
    socketPath: dirs.socketPath,
    serverVersion: CORE_VERSION,
    tokens: authority,
    store,
    hub,
    engine,
    broker,
    dirs: sessionDirs,
    trust: trustStore,
    bg: bgRegistry,
    skills: skillStore,
    mcp: mcp ?? undefined,
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
