import { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
import { acquireLock, type Lock } from "./lock";
import { TokenAuthority } from "./auth/tokens";
import { KeychainSecretStore, type SecretStore } from "./auth/secret-store";
import { SessionStore } from "./sessions/store";
import { SessionHub } from "./sessions/hub";
import { startIpcServer, type IpcServer, type IpcServerOptions } from "./ipc/server";
import { loadSettings } from "./settings";
import { createProvider } from "./providers/manager";
import type { Provider } from "./providers/types";
import { ToolRegistry } from "./agent/tools/registry";
import { registerReadTools } from "./agent/tools/fs-read";
import { registerWriteTools } from "./agent/tools/fs-write";
import { registerBashTool } from "./agent/tools/bash";
import { PermissionGate } from "./agent/gate";
import { ApprovalBroker } from "./agent/approvals";
import { AgentEngine } from "./agent/engine";

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
  if (agentProvider) {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registerWriteTools(registry);
    registerBashTool(registry);
    broker = new ApprovalBroker();
    engine = new AgentEngine({
      store, hub, registry, broker,
      gate: new PermissionGate(),
      provider: agentProvider,
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
    ...opts.server,
  });

  console.error(`norma-core ${CORE_VERSION} listening on ${dirs.socketPath}`);
  return {
    socketPath: dirs.socketPath,
    tokens,
    stop() { server.stop(); store.close(); lock.release(); },
  };
}

// Direct execution: `bun run src/daemon.ts` (also the compiled binary's `daemon run` path).
if (import.meta.main) {
  const daemon = await startDaemon();
  const shutdown = () => { daemon.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
