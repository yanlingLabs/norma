import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket,
} from "@norma/protocol";

/**
 * `@norma/plugin-sdk` — the Tier-2 plugin authoring library (design spec §4, plan Phase 4b
 * Task 5). `createPlugin({tools, onShortcut, tile}).serve()` owns the WHOLE lifecycle contract
 * (connect, hello, register, dispatch, reconnect, clean shutdown) so a plugin author never has
 * to implement it themselves — see the class doc below for the exact wire sequence.
 *
 * SELF-CONTAINED BY DESIGN: this package imports wire *types* from `@norma/protocol` (a
 * declared dependency) but never `packages/core` — a plugin process is a separate OS process the
 * supervisor spawns (packages/core/src/plugins/supervisor.ts), so pulling in core's daemon
 * machinery here would be both wrong (core is a server, this is a client) and a dependency
 * cycle risk. The NDJSON framing/request-response correlation below is a small, deliberately
 * duplicated mirror of `packages/cli/src/client.ts`'s `NormaClient` — same shapes over the wire,
 * independent implementation, so plugin authors installing this package never pull in the CLI or
 * core.
 */

// -------------------------------------------------------------------------------------------
// Public surface (plan Task 5 "Produces" — the createPlugin signature is the contract).
// -------------------------------------------------------------------------------------------

export interface PluginToolDef {
  description: string;
  /** Raw JSON-schema-shaped record, passed to core verbatim (protocol's `ToolRegisterParams.
   *  parameters` — core does not re-validate its shape beyond "is an object"). Omit for a
   *  schema-less tool (still registrable — spec §3 "optionally deferred JSON schema"). */
  parameters?: Record<string, unknown>;
  /** Handler for a `plugin_tool_invoke` dispatch. Sync or async; a thrown error (or a rejected
   *  promise) becomes `plugin.toolResult {error: message}`; a returned value is JSON.stringified
   *  into `plugin.toolResult {resultJson}`. */
  run: (args: unknown) => unknown | Promise<unknown>;
}

export interface PluginDefinition {
  tools?: Record<string, PluginToolDef>;
  /** Shortcut invocation routing is Phase 4d — in 4b this callback is accepted and stored (so
   *  4d's wiring is a pure addition, never a breaking API change) but never invoked. What DOES
   *  happen in 4b: if this is set, `serve()` registers whatever shortcut ids the plugin's own
   *  `norma-plugin.json` (`contributes.shortcuts`, design spec §1/§6 — "plugins declare shortcut
   *  IDs in the manifest") declares, via `shortcut.register`, on every (re)registration. Reading
   *  the manifest is a plain `fs.readFileSync` off `process.cwd()` (the supervisor spawns each
   *  plugin process cwd'd into its own plugin directory) — never a `packages/core` import, and
   *  never throws: a missing/malformed manifest or an empty/absent `shortcuts` list just means
   *  nothing gets registered this cycle. */
  onShortcut?: (id: string) => void;
  /** When set, `serve()` calls this and pushes one `tile.update` immediately after registration
   *  completes — including after every reconnect (core restarts wipe its in-memory contrib
   *  registry, so a stale tile would otherwise linger until the plugin's next voluntary push). */
  tile?: () => Record<string, unknown>;
}

export interface ServeOptions {
  /** Defaults to `NORMA_SOCKET`. */
  socketPath?: string;
  /** Defaults to `NORMA_PLUGIN_TOKEN`. */
  token?: string;
  /** Defaults to `NORMA_PLUGIN_ID`. */
  pluginId?: string;
}

export interface Plugin {
  /** Connects, hellos as role "plugin", registers everything declared in the `createPlugin` def,
   *  and starts the dispatch loop. Resolves once the FIRST full registration cycle succeeds (the
   *  connection then keeps running/dispatching/reconnecting in the background — nothing further
   *  needs to be awaited). Rejects only for a static configuration error (a socketPath/token/
   *  pluginId that resolves to neither an option nor an env var) — an actual connection failure
   *  is retried with backoff, never surfaced as a rejection, matching "core restart resilience". */
  serve(opts?: ServeOptions): Promise<void>;
  /** Deliberate shutdown: stops any pending reconnect, closes the socket, removes the
   *  SIGTERM/SIGINT handlers `serve()` installed. Idempotent. Does NOT call `process.exit` itself
   *  — the installed signal handlers do that (spec: "SIGTERM/SIGINT: close socket, exit 0"); a
   *  caller invoking `close()` directly (e.g. tests, or a plugin author's own shutdown path) gets
   *  a clean disconnect without the process being killed out from under it. */
  close(): void;
}

// -------------------------------------------------------------------------------------------
// Reconnect backoff — spec: "1s·2ⁿ backoff cap 30s" (the SDK side; core's own supervisor uses a
// DIFFERENT cap, 60s — see supervisor.ts's `backoffDelayMs`, an intentionally separate constant
// for a separate process). Pure + exported for direct testing, same discipline as core's.
// -------------------------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;

export function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS);
}

// -------------------------------------------------------------------------------------------
// Manifest-declared shortcut ids (see PluginDefinition.onShortcut's doc comment above).
// -------------------------------------------------------------------------------------------

interface DeclaredShortcut { id: string; description?: string; default?: string }

function readDeclaredShortcuts(): DeclaredShortcut[] {
  try {
    const raw = readFileSync(join(process.cwd(), "norma-plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as { contributes?: { shortcuts?: unknown } };
    const shortcuts = parsed.contributes?.shortcuts;
    if (!Array.isArray(shortcuts)) return [];
    const out: DeclaredShortcut[] = [];
    for (const s of shortcuts) {
      if (!s || typeof s !== "object") continue;
      const id = (s as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) continue;
      const entry: DeclaredShortcut = { id };
      const description = (s as Record<string, unknown>).description;
      if (typeof description === "string") entry.description = description;
      const def = (s as Record<string, unknown>).default;
      if (typeof def === "string") entry.default = def;
      out.push(entry);
    }
    return out;
  } catch {
    return []; // missing/malformed manifest: never bricks (same posture as core's loadManifest)
  }
}

// -------------------------------------------------------------------------------------------
// createPlugin.
// -------------------------------------------------------------------------------------------

type PendingEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export function createPlugin(def: PluginDefinition): Plugin {
  let socketPath: string | undefined;
  let token: string | undefined;
  let pluginId: string | undefined;

  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let writer: ConnWriter | null = null;
  let decoder = new LineDecoder();
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();

  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let firstConnectResolve: (() => void) | null = null;

  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  function request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!writer) return Promise.reject(new Error(`plugin-sdk: not connected (method ${method})`));
    const id = nextId++;
    const w = writer;
    w.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  function sendToolResult(params: { requestId: string; resultJson?: string; error?: string }): void {
    request(METHODS.pluginToolResult, params).catch(() => {
      /* socket may already be gone (reconnect in flight) — the invoke times out core-side. */
    });
  }

  async function handleInvoke(ev: { requestId: string; tool: string; argsJson: string }): Promise<void> {
    const toolDef = def.tools?.[ev.tool];
    if (!toolDef) {
      sendToolResult({ requestId: ev.requestId, error: `unknown tool: ${ev.tool}` });
      return;
    }
    try {
      const args: unknown = JSON.parse(ev.argsJson);
      const result = await toolDef.run(args);
      sendToolResult({ requestId: ev.requestId, resultJson: JSON.stringify(result === undefined ? null : result) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendToolResult({ requestId: ev.requestId, error: message });
    }
  }

  /** One full connect → hello → register-everything cycle. Rerun verbatim on every reconnect
   *  (spec: "on reconnect redo hello+register-everything — core restart resilience"), so there is
   *  exactly one registration code path for both the first connect and every later one. */
  async function connectOnce(): Promise<void> {
    decoder = new LineDecoder();
    const sock = await Bun.connect({
      unix: socketPath!,
      socket: {
        data(s, chunk) {
          let lines: string[];
          try {
            lines = decoder.push(chunk);
          } catch {
            s.end();
            return;
          }
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
              const p = pending.get(msg.id)!;
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
              else p.resolve(msg.result);
            } else if (msg.method === METHODS.event && msg.params?.type === "plugin_tool_invoke") {
              handleInvoke(msg.params).catch(() => {});
            }
            // every other event type (or notification) is skipped — 4b's dispatch loop only
            // answers plugin_tool_invoke; shortcut.invoke routing is Phase 4d.
          }
        },
        drain() {
          writer?.onDrain();
        },
        close() {
          writer = null;
          socket = null;
          for (const p of pending.values()) p.reject(new Error("connection closed"));
          pending.clear();
          if (!closed) scheduleReconnect();
        },
        error() {}, // close() always follows and rejects pending — stub silences Bun's stderr print
      },
    });
    socket = sock;
    writer = new ConnWriter(sock as unknown as WritableSocket);

    await request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION,
      role: "plugin",
      token,
      pluginId,
      clientName: `plugin:${pluginId}`,
    });
    await request(METHODS.pluginRegister, { pluginId });
    for (const [name, toolDef] of Object.entries(def.tools ?? {})) {
      await request(METHODS.toolRegister, {
        name, description: toolDef.description, parameters: toolDef.parameters,
      });
    }
    if (def.onShortcut) {
      const shortcuts = readDeclaredShortcuts();
      if (shortcuts.length > 0) await request(METHODS.shortcutRegister, { shortcuts });
    }
    if (def.tile) {
      await request(METHODS.tileUpdate, { tile: def.tile() });
    }

    reconnectAttempt = 0;
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = backoffDelayMs(reconnectAttempt);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptConnect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function attemptConnect(): void {
    connectOnce()
      .then(() => {
        firstConnectResolve?.();
        firstConnectResolve = null;
      })
      .catch(() => scheduleReconnect());
  }

  function installSignalHandlers(): void {
    if (sigtermHandler) return; // already installed by a previous serve() call on this instance
    sigtermHandler = () => { close(); process.exit(0); };
    sigintHandler = () => { close(); process.exit(0); };
    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);
  }

  function removeSignalHandlers(): void {
    if (sigtermHandler) { process.off("SIGTERM", sigtermHandler); sigtermHandler = null; }
    if (sigintHandler) { process.off("SIGINT", sigintHandler); sigintHandler = null; }
  }

  function serve(opts?: ServeOptions): Promise<void> {
    socketPath = opts?.socketPath ?? process.env.NORMA_SOCKET;
    token = opts?.token ?? process.env.NORMA_PLUGIN_TOKEN;
    pluginId = opts?.pluginId ?? process.env.NORMA_PLUGIN_ID;

    const missing: string[] = [];
    if (!socketPath) missing.push("socketPath (NORMA_SOCKET)");
    if (!token) missing.push("token (NORMA_PLUGIN_TOKEN)");
    if (!pluginId) missing.push("pluginId (NORMA_PLUGIN_ID)");
    if (missing.length > 0) {
      return Promise.reject(new Error(`createPlugin().serve(): missing ${missing.join(", ")}`));
    }

    closed = false;
    installSignalHandlers();

    return new Promise((resolve) => {
      firstConnectResolve = resolve;
      attemptConnect();
    });
  }

  function close(): void {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    removeSignalHandlers();
    const s = socket;
    socket = null;
    writer = null;
    for (const p of pending.values()) p.reject(new Error("connection closed"));
    pending.clear();
    try { s?.end(); } catch { /* already gone */ }
  }

  return { serve, close };
}
