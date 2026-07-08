import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { loadSettings } from "../../src/settings";
import { PluginStore, pluginSpawnEligible } from "../../src/agent/plugins";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { PluginSupervisor } from "../../src/plugins/supervisor";
import { PluginContribRegistry } from "../../src/plugins/contrib";

/**
 * Phase 4b Task 6 — the sample-echo reference plugin, proven end to end against a REAL `bun
 * index.ts` child process (no scripted/fake connection anywhere in this file — that coverage
 * already exists in server.test.ts's "plugin tool bridge (Task 4)" suite, which injects a fake
 * `spawn` and drives the "plugin" side with a raw `TestClient` socket). This suite boots a real
 * IPC server (mirroring server.test.ts's `bootBridgeServer` construction — direct `ToolRegistry`/
 * `PluginSupervisor`/`PluginContribRegistry` instances, since neither `RunningDaemon` nor
 * `IpcServer` exposes them) and a real `PluginSupervisor` with PRODUCTION spawn/signal deps (all
 * omitted below — only timing knobs are shortened for test speed), pointed at a tmp `normaHome`
 * that has `examples/sample-echo` actually installed, enabled, and exec-consented in
 * `settings.json` — exactly the state `pluginSpawnEligible` (agent/plugins.ts) requires before the
 * real daemon would ever spawn it.
 *
 * SDK IMPORT PATH: `examples/sample-echo/index.ts` imports `@norma/plugin-sdk` as a normal
 * workspace dependency (package.json: `"@norma/plugin-sdk": "workspace:*"`) — that resolves fine
 * for the real, pnpm-installed `examples/sample-echo` package. But this suite spawns `bun
 * index.ts` out of a COPY of that directory under a throwaway tmp `normaHome/plugins/sample-echo`
 * (copy, not symlink — installed plugins are real directories on disk, and the manifest's
 * `dirName === manifest.id` semantics in agent/plugin-manifest.ts#loadManifest depend on that), and
 * a bare copy has no `node_modules` of its own (copying pnpm's relative symlinks would break
 * anyway — the relative depth from a tmp dir elsewhere on disk is different). `installSampleEcho`
 * below therefore rewrites the ONE bare-specifier import in the COPY to an absolute file path
 * straight at the SDK's real TypeScript source (`packages/plugin-sdk/src/index.ts`), leaving
 * `examples/sample-echo` itself untouched/clean. This works because Bun/Node resolve a module's
 * OWN bare specifiers (e.g. the SDK's `import ... from "@norma/protocol"`) relative to the file
 * doing the importing, not the entry point — so the SDK file, imported from its real unmoved
 * location, still finds `packages/plugin-sdk/node_modules/@norma/protocol` normally. Verified
 * manually against a throwaway fixture server before this suite was written.
 */

const EXAMPLES_DIR = join(import.meta.dir, "../../../../examples/sample-echo");
const PLUGIN_SDK_ENTRY = join(import.meta.dir, "../../../plugin-sdk/src/index.ts");

/** Copies `examples/sample-echo` into `<normaHome>/plugins/<pluginId>` and rewrites its
 *  `@norma/plugin-sdk` import to an absolute path (see file doc comment above). Returns the
 *  installed directory. */
function installSampleEcho(normaHome: string, pluginId: string): string {
  const dest = join(normaHome, "plugins", pluginId);
  cpSync(EXAMPLES_DIR, dest, { recursive: true });
  const indexPath = join(dest, "index.ts");
  const rewritten = readFileSync(indexPath, "utf8").replace(
    'from "@norma/plugin-sdk"',
    `from ${JSON.stringify(PLUGIN_SDK_ENTRY)}`,
  );
  writeFileSync(indexPath, rewritten);
  return dest;
}

/** `ps -p <pid>` liveness probe — real process check (not `process.kill(pid, 0)`), matching the
 *  "verify with a ps check on the child pid" requirement for the no-orphan-process assertion. */
function isPidAlive(pid: number): boolean {
  const result = Bun.spawnSync(["ps", "-p", String(pid)]);
  return result.exitCode === 0;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function bootSupervisedServer(pluginId: string): Promise<{
  home: string;
  store: SessionStore;
  socketPath: string;
  registry: ToolRegistry;
  supervisor: PluginSupervisor;
  contrib: PluginContribRegistry;
  stop: () => void;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-supervised-e2e-"));
  installSampleEcho(home, pluginId);

  // "installed + ENABLED + exec-CONSENTED in settings" — a real settings.json on disk, read
  // through the real loadSettings() pipeline (server.test.ts's `boot()` convention), not a
  // hand-built PluginStore fixture.
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "gpt-5.4" }, // unused (nothing here constructs a real provider) but required by the settings schema
    plugins: { enabled: [pluginId], consents: { [pluginId]: { exec: Date.now() } } },
  }));
  const settings = loadSettings(join(home, "settings.json"));

  const store = new SessionStore(home);
  const socketPath = join(home, "core.sock");
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  await authority.ensureTokens();

  const registry = new ToolRegistry();
  const contrib = new PluginContribRegistry();
  // PRODUCTION deps throughout: spawn/isAlivePid/signalPid/processStartedAt are all omitted, so
  // the supervisor uses the REAL Bun.spawn/process.kill/ps — this is the whole point of this
  // suite, versus server.test.ts's "plugin tool bridge (Task 4)" tests, which inject a fake spawn
  // and drive the "plugin" side with a scripted TestClient. Only the timing knobs are shortened
  // for test speed; `killGraceMs` is a constructor-only test-injection seam per supervisor.ts's own
  // doc comment (never settings.json-overridable), distinct from the spawn/signal seams above.
  const supervisor = new PluginSupervisor({
    runDir: join(home, "run"),
    socketPath,
    mintToken: (id) => store.mintPluginToken(id),
    settings: { registrationTimeoutMs: 10_000, killGraceMs: 1_500 },
    onLog: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[supervisor] ${m}`); },
    onCircuitOpen: (id) => registry.unregisterByPrefix(`plugin__${id}__`),
  });

  // The socket must already be listening before startAll() spawns the child — the child connects
  // to NORMA_SOCKET immediately on startup.
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, registry, supervisor, contrib });

  const pluginStore = new PluginStore({
    normaHome: home, plugins: settings.plugins, consents: settings.plugins?.consents,
    log: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[plugins] ${m}`); },
  });
  const spawnable = pluginStore.list()
    .filter(pluginSpawnEligible)
    .map((p) => ({ id: p.name, dir: join(home, "plugins", p.name), entry: p.entry! }));
  expect(spawnable.map((p) => p.id)).toEqual([pluginId]); // sanity: the eligibility pipeline actually picked it up
  supervisor.startAll(spawnable);

  return {
    home, store, socketPath, registry, supervisor, contrib,
    stop: () => { supervisor.stopAll(); server.stop(); store.close(); },
  };
}

describe("supervised e2e: sample-echo (real Bun child process)", () => {
  let srv: Awaited<ReturnType<typeof bootSupervisedServer>> | null = null;

  afterEach(() => { srv?.stop(); srv = null; });

  test(
    "real child registers within the timeout, echo round-trips through registry.execute with the real child's pid, tile lands in the contrib registry, and teardown leaves no orphan process",
    async () => {
      const pluginId = "sample-echo";
      srv = await bootSupervisedServer(pluginId);

      // 1. Registration: the real `bun index.ts` child connects, hellos as role "plugin", and
      // calls plugin.register — the supervisor status flips out of "starting" into "running".
      await waitFor(
        () => srv!.supervisor.status(pluginId) === "running",
        10_000,
        `supervisor status "running" for ${pluginId}`,
      );

      // 2. Tool registration: plugin.register resolving flips supervisor status to "running"
      // BEFORE the child's subsequent tool.register calls (for both `echo` and `sleep`, per
      // examples/sample-echo/index.ts) land — wait for both explicitly rather than assuming they
      // raced ahead of the status flip above.
      await waitFor(
        () => srv!.registry.has(`plugin__${pluginId}__echo`) && srv!.registry.has(`plugin__${pluginId}__sleep`),
        5_000,
        `plugin__${pluginId}__{echo,sleep} registered`,
      );

      // 3. Echo round-trip: registry.execute pushes plugin_tool_invoke over the REAL socket to
      // the REAL child, which runs its `echo` handler and answers with plugin.toolResult — the
      // full PluginSupervisor.invoke() correlation path, no fake connection involved.
      const outcome = await srv.registry.execute(
        `plugin__${pluginId}__echo`,
        { text: "hi" },
        { cwd: "/", roots: ["/"], sessionId: "e2e" },
      );
      expect(outcome.isError).toBe(false);
      const parsed = JSON.parse(outcome.output) as { echo: string; pluginPid: number };
      expect(parsed.echo).toBe("hi");
      expect(Number.isInteger(parsed.pluginPid)).toBe(true);
      expect(parsed.pluginPid).toBeGreaterThan(0);
      expect(parsed.pluginPid).not.toBe(process.pid); // really a separate spawned process
      expect(isPidAlive(parsed.pluginPid)).toBe(true);
      const childPid = parsed.pluginPid;

      // 4. Tile contribution: examples/sample-echo/index.ts declares `tile: () => ({...})` — the
      // SDK pushes tile.update once, right after registration; poll since it can race the echo
      // round-trip above (both fire off the same registration cycle, no ordering guarantee).
      await waitFor(
        () => srv!.contrib.get(pluginId)?.tile !== undefined,
        2_000,
        `tile.update landed in the contrib registry for ${pluginId}`,
      );
      expect(srv.contrib.get(pluginId)?.tile).toEqual({ title: "Sample Echo", value: "ready" });

      // 5. Clean teardown: stop() (supervisor.stopAll() + server.stop() + store.close()) SIGTERMs
      // the real child; the SDK's own signal handler closes its socket and calls process.exit(0).
      // No orphan process should survive — verified with a real `ps -p` check, not just "the
      // promise resolved".
      const registry = srv.registry;
      const booted = srv;
      srv = null; // afterEach must not double-stop
      booted.stop();

      await waitFor(() => !isPidAlive(childPid), 5_000, `child pid ${childPid} to exit after stop()`);
      expect(isPidAlive(childPid)).toBe(false);

      // Bonus: the ipc server's own socket-close handler unregisters the plugin's tools
      // independently of the supervisor's own bookkeeping above — confirms teardown is clean on
      // both sides, not just "the process died".
      await waitFor(() => !registry.has(`plugin__${pluginId}__echo`), 2_000, `plugin__${pluginId}__echo unregistered after disconnect`);
    },
    20_000,
  );
});
