import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, LineDecoder, METHODS, PROTOCOL_VERSION } from "@norma/protocol";
import { backoffDelayMs, createPlugin } from "../src/index";

// -------------------------------------------------------------------------------------------
// Scripted in-process server fixture (mirrors packages/cli/test/client.test.ts's "hostile/fake
// server" pattern and packages/core/src/ipc/server.ts's Bun.listen<ConnState> shape) — just
// enough of the plugin-role wire protocol to drive `createPlugin().serve()` through a full
// handshake, dispatch a `plugin_tool_invoke` push, and support a stop/restart cycle for the
// reconnect test.
// -------------------------------------------------------------------------------------------

interface ConnState { decoder: LineDecoder }

interface ToolResultParams { requestId: string; resultJson?: string; error?: string }
interface ShortcutEntry { id: string; description?: string; default?: string }

interface FakeServer {
  order: string[];
  registeredTools: string[];
  shortcuts(): ShortcutEntry[] | null;
  tiles: Array<Record<string, unknown>>;
  toolResults: ToolResultParams[];
  connectionCount(): number;
  pushEvent(params: unknown): void;
  stop(): void;
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* nothing to remove */ }
}

function startFakeServer(path: string): FakeServer {
  safeUnlink(path); // a prior listener's socket file may still be on disk (restart tests)

  const order: string[] = [];
  const registeredTools: string[] = [];
  let shortcuts: ShortcutEntry[] | null = null;
  const tiles: Array<Record<string, unknown>> = [];
  const toolResults: ToolResultParams[] = [];
  let connections = 0;
  let active: Bun.Socket<ConnState> | null = null;

  const server = Bun.listen<ConnState>({
    unix: path,
    socket: {
      open(socket) {
        connections++;
        active = socket;
        socket.data = { decoder: new LineDecoder() };
      },
      data(socket, chunk) {
        for (const line of socket.data.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          switch (msg.method) {
            case METHODS.hello:
              order.push(METHODS.hello);
              socket.write(encodeLine({
                jsonrpc: "2.0", id: msg.id,
                result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION },
              }));
              break;
            case METHODS.pluginRegister:
              order.push(METHODS.pluginRegister);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.toolRegister:
              order.push(METHODS.toolRegister);
              registeredTools.push(msg.params.name);
              socket.write(encodeLine({
                jsonrpc: "2.0", id: msg.id,
                result: { ok: true, registeredAs: `plugin__test__${msg.params.name}` },
              }));
              break;
            case METHODS.shortcutRegister:
              order.push(METHODS.shortcutRegister);
              shortcuts = msg.params.shortcuts;
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.tileUpdate:
              order.push(METHODS.tileUpdate);
              tiles.push(msg.params.tile);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.pluginToolResult:
              toolResults.push(msg.params);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            default:
              // never answered — not exercised by these tests
              break;
          }
        }
      },
      close(socket) {
        if (active === socket) active = null;
      },
    },
  });

  return {
    order, registeredTools, tiles, toolResults,
    shortcuts: () => shortcuts,
    connectionCount: () => connections,
    pushEvent(params: unknown) {
      active?.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params }));
    },
    stop() { server.stop(true); },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// -------------------------------------------------------------------------------------------

describe("createPlugin().serve()", () => {
  let cleanups: Array<() => void>;
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    cleanups = [];
    tmpDir = mkdtempSync(join(tmpdir(), "norma-plugin-sdk-"));
    sockPath = join(tmpDir, "plugin.sock");
  });
  afterEach(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort teardown */ }
    }
  });

  test("handshake order (hello -> plugin.register -> tool.register x N) and tile push after registration", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        alpha: { description: "first tool", run: () => "a" },
        beta: { description: "second tool", run: () => "b" },
      },
      tile: () => ({ title: "Sample", value: 42 }),
    });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toEqual([
      METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister, METHODS.toolRegister, METHODS.tileUpdate,
    ]);
    expect(server.registeredTools).toEqual(["alpha", "beta"]);
    expect(server.tiles).toEqual([{ title: "Sample", value: 42 }]);
  });

  test("invoke dispatch: sync handler, async handler, throwing handler, unknown tool", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        echo: { description: "echo", run: (args) => ({ echoed: (args as { text: string }).text }) },
        addAsync: {
          description: "add",
          run: async (args) => {
            await new Promise((r) => setTimeout(r, 5));
            const a = args as { a: number; b: number };
            return a.a + a.b;
          },
        },
        boom: { description: "throws", run: () => { throw new Error("kaboom"); } },
      },
    });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r1", tool: "echo", argsJson: JSON.stringify({ text: "hi" }) });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r2", tool: "addAsync", argsJson: JSON.stringify({ a: 2, b: 3 }) });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r3", tool: "boom", argsJson: "{}" });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r4", tool: "missing", argsJson: "{}" });

    await waitFor(() => server.toolResults.length >= 4);

    const byId = Object.fromEntries(server.toolResults.map((r) => [r.requestId, r]));
    expect(JSON.parse(byId.r1!.resultJson!)).toEqual({ echoed: "hi" });
    expect(JSON.parse(byId.r2!.resultJson!)).toEqual(5);
    expect(byId.r3!.error).toBe("kaboom");
    expect(byId.r3!.resultJson).toBeUndefined();
    expect(byId.r4!.error).toBe("unknown tool: missing");
  });

  test("reconnect: server restart triggers a full re-registration handshake", async () => {
    let server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: { ping: { description: "ping", run: () => "pong" } } });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    expect(server.order).toEqual([METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister]);

    server.stop();
    safeUnlink(sockPath);

    const server2 = startFakeServer(sockPath);
    cleanups.push(() => server2.stop());

    // base reconnect delay is 1s (backoffDelayMs(0) === 1000) — give it real headroom.
    await waitFor(() => server2.order.length >= 3, 6000);
    expect(server2.order).toEqual([METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister]);
  }, 10_000);

  test("close() stops reconnecting", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    expect(server.connectionCount()).toBe(1);

    plugin.close();
    server.stop();
    safeUnlink(sockPath);

    const server2 = startFakeServer(sockPath);
    cleanups.push(() => server2.stop());

    await new Promise((r) => setTimeout(r, 1800)); // longer than the 1s base backoff
    expect(server2.connectionCount()).toBe(0);
  }, 5000);

  test("serve() installs SIGTERM/SIGINT handlers; close() removes them", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    const beforeTerm = process.listeners("SIGTERM").length;
    const beforeInt = process.listeners("SIGINT").length;

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(process.listeners("SIGTERM").length).toBe(beforeTerm + 1);
    expect(process.listeners("SIGINT").length).toBe(beforeInt + 1);

    plugin.close();

    expect(process.listeners("SIGTERM").length).toBe(beforeTerm);
    expect(process.listeners("SIGINT").length).toBe(beforeInt);
  });

  test("serve() rejects when socketPath/token/pluginId cannot be resolved (no opts, no env)", async () => {
    const savedSocket = process.env.NORMA_SOCKET;
    const savedToken = process.env.NORMA_PLUGIN_TOKEN;
    const savedId = process.env.NORMA_PLUGIN_ID;
    delete process.env.NORMA_SOCKET;
    delete process.env.NORMA_PLUGIN_TOKEN;
    delete process.env.NORMA_PLUGIN_ID;
    cleanups.push(() => {
      if (savedSocket !== undefined) process.env.NORMA_SOCKET = savedSocket;
      if (savedToken !== undefined) process.env.NORMA_PLUGIN_TOKEN = savedToken;
      if (savedId !== undefined) process.env.NORMA_PLUGIN_ID = savedId;
    });

    const plugin = createPlugin({});
    await expect(plugin.serve({})).rejects.toThrow(/missing/);
  });

  test("onShortcut: registers the shortcut ids declared in norma-plugin.json (plugin cwd)", async () => {
    writeFileSync(join(tmpDir, "norma-plugin.json"), JSON.stringify({
      id: "sample", tier: "platform",
      contributes: { shortcuts: [{ id: "toggle", description: "Toggle the thing" }] },
    }));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    cleanups.push(() => process.chdir(originalCwd));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toEqual([{ id: "toggle", description: "Toggle the thing" }]);
  });

  test("onShortcut with no manifest present never calls shortcut.register", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmpDir); // empty tmp dir — no norma-plugin.json
    cleanups.push(() => process.chdir(originalCwd));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).not.toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toBeNull();
  });

  test("NORMA_PLUGIN_DIR env var: manifest read from env var, not cwd, when set", async () => {
    // Create manifest in a separate directory
    const pluginDir = mkdtempSync(join(tmpdir(), "norma-plugin-env-"));
    cleanups.push(() => {
      try { unlinkSync(join(pluginDir, "norma-plugin.json")); } catch {}
    });
    writeFileSync(join(pluginDir, "norma-plugin.json"), JSON.stringify({
      id: "sample", tier: "platform",
      contributes: { shortcuts: [{ id: "cmd-a", description: "Command A" }, { id: "cmd-b" }] },
    }));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    // Serve with NORMA_PLUGIN_DIR pointing to the manifest, while cwd is tmpDir (which is empty)
    const savedEnv = process.env.NORMA_PLUGIN_DIR;
    process.env.NORMA_PLUGIN_DIR = pluginDir;
    cleanups.push(() => {
      if (savedEnv !== undefined) process.env.NORMA_PLUGIN_DIR = savedEnv;
      else delete process.env.NORMA_PLUGIN_DIR;
    });

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toEqual([
      { id: "cmd-a", description: "Command A" },
      { id: "cmd-b" },
    ]);
  });

  test("double serve() rejects with clear error", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    await expect(plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" }))
      .rejects.toThrow(/already serving/);
  });
});

describe("backoffDelayMs", () => {
  test("1s * 2^n, capped at 30s", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(30_000); // 32000 -> capped
    expect(backoffDelayMs(10)).toBe(30_000);
  });
});
