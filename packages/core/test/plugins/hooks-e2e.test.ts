import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket,
  type SessionEvent,
} from "@norma/protocol";
import { startIpcServer, type IpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { PluginStore } from "../../src/agent/plugins";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { HookRegistry, HookFacade } from "../../src/plugins/hook-registry";
import { HookRunner } from "../../src/plugins/hook-runner";
import { loadSettings, saveSettings, hooksEnabledFrom } from "../../src/settings";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * Phase 4f Task 4 — the whole-stack gate: a REAL fixture plugin, on disk, driven through the
 * REAL plugin-lifecycle IPC RPCs (plugin.enable/plugin.disable — ipc/server.ts) to hot-rebuild a
 * REAL `HookRegistry`, consumed by a REAL `HookFacade` (real `HookRunner`, i.e. genuine `sh -c`
 * child processes) wired into a REAL `AgentEngine`'s `cfg.hooks` — only the LLM provider is
 * scripted (`FakeProvider`). This is the missing coverage T2's reviewer flagged: no prior test
 * ever passed `hooks:` into `startIpcServer`, so `rebuildHookRegistry()` (the plugin.enable/
 * disable hot-apply path) had never actually run.
 *
 * ONE fixture plugin, "hookfixture" (capability tier — no `entry`, so `plugin.enable` hot-applies
 * to `status:"na"` with no Tier-2 process spawn; hooks are a manifest-only concept independent of
 * Tier-2 supervision — agent/plugins.ts's `pluginHooksEligible`), declares two hooks:
 *   - pre-tool: appends an "pre-tool" line to a side-effect log, then `exit 2` with stderr
 *     "policy says no" — the exact blocking contract hook-runner.test.ts's (b) already unit-tests,
 *     exercised here through the full stack instead.
 *   - session-start: appends a "session-start" line to the SAME side-effect log, then echoes a
 *     marker string to stdout (what the engine turns into a first-turn `<system-reminder>`).
 * The side-effect log is the zero-spawn proof mechanism for scenario (c): a REAL `sh -c` process
 * writing to it is the only way a line appears, so "log line count did not grow" is direct
 * evidence no hook process was spawned — stronger than a call-count spy, and the only kind of
 * proof available for the disabled-plugin case (there the registry itself is empty, so there is
 * nothing left in-process to spy on).
 *
 * ONE `PluginStore`/`HookRegistry`/`IpcServer` triple (`pluginsHome`) drives the REAL lifecycle
 * path; a SEPARATE `AgentEngine`/`SessionStore` (`engineHome`) consumes the SAME `HookRegistry`
 * instance via a `HookFacade` this test constructs itself (mirroring daemon.ts's own
 * `hookFacade`/`hooksEnabledHot` wiring) — two homes because in production these are two facets
 * of the SAME daemon process sharing one `HookRegistry`, and splitting them here keeps the
 * "plugin lifecycle" and "engine turn" halves of the test independently legible without any
 * unrelated coupling (the engine's own `SessionStore` is irrelevant to plugin lifecycle RPCs,
 * which don't touch it at all).
 */

/** Minimal raw NDJSON JSON-RPC client — same shape as server.test.ts's own `TestClient` and
 *  gate-4d-i/4d-ii's copies (duplicated per-file, per those files' own doc comments), trimmed to
 *  hello + request/response (no notification-waiting needed here). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName = "hooks-e2e-harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  close(): void { this.socket.end(); }
}

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const writeCall = (callId: string, path: string, content: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "write", argsJson: JSON.stringify({ path, content }) });

function toolResult(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined {
  return events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;
}

describe("hooks e2e: real fixture plugin + real HookRunner/HookRegistry + real engine hook points (4f Task 4)", () => {
  test(
    "enable{consent:true} hot-wires a REAL pre-tool block + session-start injection end-to-end; " +
      "hooks.enabled=false and plugin.disable each independently zero-spawn the SAME hooks (4f Task 4)",
    async () => {
      // ================= Fixture plugin on disk + the REAL plugin-lifecycle IPC server ==========
      const pluginsHome = mkdtempSync(join(tmpdir(), "norma-hooks-e2e-plugins-"));
      const settingsPath = join(pluginsHome, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({
        schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" },
      }));

      const pluginId = "hookfixture";
      const pluginDir = join(pluginsHome, "plugins", pluginId);
      mkdirSync(pluginDir, { recursive: true });

      // Side-effect log lives OUTSIDE pluginsHome/engineHome entirely — a plain append target the
      // fixture's own `sh -c` commands write to. Its line count is the zero-spawn proof for (c).
      const sideEffectDir = mkdtempSync(join(tmpdir(), "norma-hooks-e2e-side-"));
      const sideEffectLog = join(sideEffectDir, "invocations.log");
      const invocationCount = (): number => {
        try { return readFileSync(sideEffectLog, "utf8").split("\n").filter((l) => l.length > 0).length; }
        catch { return 0; } // file doesn't exist yet — zero invocations, not an error
      };

      const SESSION_START_MARKER = "HOOKS_E2E_SESSION_START_MARKER_9f3a";
      const manifest = {
        id: pluginId,
        tier: "capability" as const, // no `entry` — hooks are manifest-only, independent of Tier-2 spawn
        contributes: {
          hooks: [
            {
              event: "pre-tool" as const,
              command: `echo pre-tool >> '${sideEffectLog}'; echo 'policy says no' 1>&2; exit 2`,
            },
            {
              event: "session-start" as const,
              command: `echo session-start >> '${sideEffectLog}'; echo '${SESSION_START_MARKER}'`,
            },
          ],
        },
      };
      writeFileSync(join(pluginDir, "norma-plugin.json"), JSON.stringify(manifest));
      expect(invocationCount()).toBe(0); // sanity: nothing has run yet — the plugin isn't even enabled

      const socketPath = join(pluginsHome, "core.sock");
      const ipcStore = new SessionStore(pluginsHome);
      const authority = new TokenAuthority(new FileSecretStore(join(pluginsHome, "secrets.json")));
      const tokens = await authority.ensureTokens();
      const pluginStore = new PluginStore({ normaHome: pluginsHome });
      const hookRegistry = new HookRegistry();
      // THE coverage gap this task closes: `hooks: hookRegistry` + `normaHome` wired into a REAL
      // startIpcServer — no prior test anywhere in the suite does this (T2's reviewer flag).
      const ipcServer: IpcServer = startIpcServer({
        socketPath, serverVersion: "test", tokens: authority, store: ipcStore,
        plugins: pluginStore, hooks: hookRegistry, normaHome: pluginsHome,
      });

      expect(hookRegistry.hooksFor("pre-tool")).toEqual([]); // nothing eligible before any RPC
      expect(hookRegistry.hooksFor("session-start")).toEqual([]);

      const harness = await TestClient.connect(socketPath);
      await harness.hello(tokens.harness);

      // plugin.enable with NO consent -> needs_consent, and hook eligibility (consent-gated, not
      // just enabled-gated — agent/plugins.ts's pluginHooksEligible) stays empty.
      const enableNoConsent = await harness.request(METHODS.pluginEnable, { name: pluginId });
      expect(enableNoConsent.result.code).toBe("needs_consent");
      expect(hookRegistry.hooksFor("pre-tool")).toEqual([]);

      // ---- REAL lifecycle path: plugin.enable{consent:true} hot-rebuilds hookRegistry ----------
      const enableRes = await harness.request(METHODS.pluginEnable, { name: pluginId, consent: true });
      expect(enableRes.result).toMatchObject({ ok: true, status: "na" }); // capability tier: nothing to spawn

      const settingsAfterEnable = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settingsAfterEnable.plugins.enabled).toEqual([pluginId]);
      expect(settingsAfterEnable.plugins.consents[pluginId].exec).toBeGreaterThan(0);

      // Proves the enable RPC's rebuildHookRegistry() call reached THIS EXACT HookRegistry instance
      // — the one the engine's HookFacade below is about to consume.
      expect(hookRegistry.hooksFor("pre-tool")).toHaveLength(1);
      expect(hookRegistry.hooksFor("pre-tool")[0]).toMatchObject({ pluginId, cwd: pluginDir });
      expect(hookRegistry.hooksFor("session-start")).toHaveLength(1);

      // ================= Real engine, real HookFacade (real HookRunner, real HookRegistry) =======
      // `hooksEnabledHot` mirrors daemon.ts's own hot settings.json read (minus its mtime cache,
      // irrelevant for a test) — this IS "settings.hooks.enabled", not a stand-in for it, so the
      // (c) "hooks.enabled=false in settings" scenario below is genuinely settings-driven.
      const hooksEnabledHot = () => hooksEnabledFrom(loadSettings(settingsPath));
      const hookFacade = new HookFacade({ registry: hookRegistry, runner: new HookRunner(), hooksEnabled: hooksEnabledHot });

      const engineHome = mkdtempSync(join(tmpdir(), "norma-hooks-e2e-engine-home-"));
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-hooks-e2e-cwd-")));
      const sessionStore = new SessionStore(engineHome);
      const hub = new SessionHub(sessionStore);
      const registry = new ToolRegistry();
      registerReadTools(registry);
      registerWriteTools(registry);
      const broker = new ApprovalBroker();

      // 7 scripted provider rounds total: turn1 (write blocked -> tool_calls, then a closing
      // text/end_turn), turn2 (plain text, no tool call — proves the reminder is turn-1-only),
      // the (c2)/(c1) turns (write succeeds -> tool_calls, then a closing text/end_turn each).
      const provider = new FakeProvider([
        [writeCall("w1", "blocked.txt", "should never reach disk"), done("tool_calls")], // turn1 round1
        text("turn1 wrapped up"),                                                        // turn1 round2
        text("turn2, nothing to do"),                                                    // turn2 (no tool call)
        [writeCall("w2", "allowed-c2.txt", "written while hooks.enabled=false"), done("tool_calls")], // c2 round1
        text("c2 wrapped up"),                                                           // c2 round2
        [writeCall("w3", "allowed-c1.txt", "written after plugin.disable"), done("tool_calls")],      // c1 round1
        text("c1 wrapped up"),                                                           // c1 round2
      ]);

      const dirs = new SessionDirectories(() => [cwd]);
      const assemblerHome = mkdtempSync(join(tmpdir(), "norma-hooks-e2e-actx-"));
      const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
      const assembler = new ContextAssembler({
        normaHome: assemblerHome,
        trust: assemblerTrust,
        skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
      });
      const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store: sessionStore, hub });

      const engine = new AgentEngine({
        store: sessionStore, hub, registry, broker,
        gate: new PermissionGate(),
        provider: { provider, model: "fake-1" },
        dirs,
        approvalTimeoutMs: 500,
        assembler,
        compactor,
        hooks: hookFacade,
      });

      const sessionId1 = sessionStore.createSession("global", { cwd, approvalPolicy: "auto" });
      hub.attach({ clientName: "obs1", deliver: () => true }, sessionId1, 0);
      const sessionId2 = sessionStore.createSession("global", { cwd, approvalPolicy: "auto" });
      hub.attach({ clientName: "obs2", deliver: () => true }, sessionId2, 0);
      const sessionId3 = sessionStore.createSession("global", { cwd, approvalPolicy: "auto" });
      hub.attach({ clientName: "obs3", deliver: () => true }, sessionId3, 0);

      // ---------------------------------------------------------------------------------------
      // (a)+(b): enabled+consented — pre-tool blocks `write` end-to-end (real process, real
      // exit-2/stderr protocol) AND session-start injects the marker into ONLY the first turn.
      // ---------------------------------------------------------------------------------------
      await engine.runTurn(sessionId1); // turn 1
      const eventsAfterTurn1 = sessionStore.read(sessionId1);
      const w1 = toolResult(eventsAfterTurn1, "w1");
      expect(w1).toMatchObject({ isError: true, output: `blocked by plugin hook ${pluginId}: policy says no` });
      expect(existsSync(join(cwd, "blocked.txt"))).toBe(false); // the write tool never ran — file absent

      // Both the session-start AND pre-tool hooks are REAL sh -c processes that ran exactly once
      // each during turn 1 — two lines in the side-effect log.
      expect(invocationCount()).toBe(2);

      const injected = (input: unknown[]) =>
        input.some((i) => typeof (i as { content?: unknown }).content === "string"
          && (i as { content: string }).content.includes(SESSION_START_MARKER)
          && (i as { content: string }).content.includes("<system-reminder>"));
      expect(injected(provider.requests[0]!.input)).toBe(true); // turn 1's first provider round

      await engine.runTurn(sessionId1); // turn 2 (same session — session-start already fired)
      expect(injected(provider.requests[2]!.input)).toBe(false); // turn 2's only provider round
      expect(invocationCount()).toBe(2); // unchanged — session-start did not fire again

      // ---------------------------------------------------------------------------------------
      // (c) variant 1: settings.hooks.enabled=false, plugin STILL enabled+consented (registry
      // untouched) — the write succeeds and ZERO hook processes spawn, proving the facade's
      // fast-path short-circuit (hook-registry.ts's runFor) never reaches HookRunner.run at all.
      // ---------------------------------------------------------------------------------------
      saveSettings(settingsPath, { ...loadSettings(settingsPath), hooks: { enabled: false } });
      expect(hookRegistry.hooksFor("pre-tool")).toHaveLength(1); // registry itself is UNCHANGED
      expect(hookRegistry.hooksFor("session-start")).toHaveLength(1);

      await engine.runTurn(sessionId2);
      const w2 = toolResult(sessionStore.read(sessionId2), "w2");
      expect(w2).toMatchObject({ isError: false });
      expect(readFileSync(join(cwd, "allowed-c2.txt"), "utf8")).toBe("written while hooks.enabled=false");
      expect(invocationCount()).toBe(2); // STILL unchanged — no hook process ran (pre-tool OR session-start)

      // ---------------------------------------------------------------------------------------
      // (c) variant 2: hooks.enabled restored to true, but the plugin is DISABLED via the REAL
      // plugin.disable RPC — proving the hot-rebuild-on-disable path (the other half of T4's
      // coverage gap) genuinely empties the registry, not merely that the facade suppresses it.
      // ---------------------------------------------------------------------------------------
      saveSettings(settingsPath, { ...loadSettings(settingsPath), hooks: { enabled: true } });

      const disableRes = await harness.request(METHODS.pluginDisable, { name: pluginId });
      expect(disableRes.result).toEqual({ ok: true });

      const settingsAfterDisable = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settingsAfterDisable.plugins.enabled).toEqual([]);
      expect(settingsAfterDisable.plugins.disabled).toEqual([pluginId]);
      expect(settingsAfterDisable.plugins.consents?.[pluginId]).toBeUndefined(); // fresh-consent strip

      // Proves plugin.disable's rebuildHookRegistry() call reached the SAME HookRegistry instance.
      expect(hookRegistry.hooksFor("pre-tool")).toEqual([]);
      expect(hookRegistry.hooksFor("session-start")).toEqual([]);

      await engine.runTurn(sessionId3);
      const w3 = toolResult(sessionStore.read(sessionId3), "w3");
      expect(w3).toMatchObject({ isError: false });
      expect(readFileSync(join(cwd, "allowed-c1.txt"), "utf8")).toBe("written after plugin.disable");
      expect(invocationCount()).toBe(2); // STILL unchanged — the registry has zero hooks, nothing to spawn

      harness.close();
      ipcServer.stop();
      ipcStore.close();
      sessionStore.close();
    },
    15_000,
  );
});
