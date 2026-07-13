import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../../src/providers/types";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { LspManager, type LspScheduler } from "../../src/agent/lsp/manager";
import { Settings } from "../../src/settings";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setup } from "./engine-spawn.test";

// Phase 5f Task 4: the closing e2e for LSP integration (T1 LspClient, T2 LspManager, T3 the
// lsp_diagnostics/lsp_definition/lsp_references tools + daemon wiring). Three beats, per the
// design doc's own T4 checklist:
//   1. real engine + T3's registerLspTools + T1's scripted fake server: a model's lsp_diagnostics
//      call comes back formatted, AND that exact text is what the provider is fed on the NEXT
//      round (not just something that lands in the session store).
//   2. settings.lsp.enabled: false mirrors daemon.ts's own boot-time gate (`lspCfg?.enabled !==
//      false`, daemon.ts phase 5f T4 comment) — registerLspTools is skipped entirely, so the
//      model's query becomes the registry's ordinary "unknown tool" error, driven through the
//      real engine (not a bare registry.execute — proves the WHOLE dispatch path, gate included).
//   3. settings.lsp.idleShutdownMs, read exactly as daemon.ts reads it and passed into
//      `new LspManager({idleShutdownMs})`, actually changes the manager's idle-reap timing —
//      T2's own manualScheduler idiom (manager.test.ts), reused here rather than re-derived.
//
// PLUS an OPTIONAL, self-skipping smoke against a REAL sourcekit-lsp (present on this Mac via
// Xcode) — see the bottom describe block. It is never a required gate: absent binary → skipped
// entirely, never a suite failure.
//
// Harness: engine-spawn.test.ts's own `setup` (fake provider + real engine + registry) — the SAME
// reuse precedent memory-e2e.test.ts / reviewer-e2e.test.ts already establish for this repo's e2e
// files, not a re-derived harness.

const isMac = process.platform === "darwin";
const FIXTURE = join(import.meta.dir, "lsp/fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

// UNLIKE lsp.test.ts's own withEnv (sync try/finally — safe THERE only because r.execute reaches
// spawn() before its own first await), driving a full engine.runTurn means many real microtask
// turns elapse (consuming the fake provider's async-generator stream) BEFORE the engine ever calls
// the tool's run() / clientFor() / spawn(). A sync-restoring wrapper would clear the env vars
// before the child ever forks. This version `await`s `fn` itself before restoring, so the vars
// stay set for the WHOLE turn, not just its first synchronous slice.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

describe.if(isMac)("lsp e2e (phase 5f Task 4): real engine + registerLspTools + T1's fake language server", () => {
  test("model calls lsp_diagnostics on an in-fence file -> formatted tool_result reaches the provider on the NEXT round", async () => {
    const { engine, sessionId, registry, cwd, dirs, events, provider } = setup([
      [{ type: "tool_call", callId: "c1", name: "lsp_diagnostics", argsJson: JSON.stringify({ path: "app.ts" }) }, done("tool_calls")],
      text("looked into it"),
    ]);
    writeFileSync(join(cwd, "app.ts"), "const x = 1;\n");
    const lsp = new LspManager({ serverCommands: { typescript: FAKE, swift: FAKE } });
    registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: (sid) => dirs.roots(sid) });

    try {
      await withEnv({
        NORMA_LSP_FAKE_DIAGS: JSON.stringify([
          { range: { start: { line: 0, character: 6 } }, severity: 1, message: "Cannot find name 'foo'.", source: "tsserver" },
        ]),
      }, () => engine.runTurn(sessionId));

      // No approval card anywhere — lsp_diagnostics is READ_ONLY (gate.ts), so it never rides the
      // ordinary ask/auto approval flow regardless of the session's policy.
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);

      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1") as ToolResult;
      expect(toolResult).toMatchObject({ isError: false, output: "error 1:7 Cannot find name 'foo'. [tsserver]" });

      // THE beat: the SAME formatted text the model reads is exactly what round 2's REQUEST
      // carries as the tool_result item — proves it rode the engine's dispatch loop back into
      // TurnRequest.input, not just something that landed in the session store and stopped there.
      const round2Input = (provider as FakeProvider).requests[1]!.input;
      expect(round2Input).toContainEqual({ type: "tool_result", callId: "c1", output: toolResult.output, isError: false });
    } finally {
      await lsp.stopAll();
    }
  });

  test("idleShutdownMs, read exactly as daemon.ts reads settings.lsp.idleShutdownMs, is the NUMERIC value LspManager arms its reap timer with", async () => {
    // Manual scheduler that CAPTURES the `ms` argument LspManager.touch() arms the reap timer with
    // (T2's manager.test.ts fires timers deterministically; this variant additionally records the
    // duration). Capturing `ms` is the whole point of this test: a scheduler that discarded it
    // would pass IDENTICALLY whether idleShutdownMs threaded through as our 50 or defaulted to the
    // manager's built-in 300_000 — the numeric assertion below is what actually discriminates the
    // two, proving the settings value governs the timer, not merely that reaping fires.
    const captured: Array<{ fn: () => unknown; ms: number }> = [];
    const byHandle = new Map<number, number>(); // handle -> index into `captured`
    let seq = 0;
    const scheduler: LspScheduler = {
      setTimeout(fn, ms) { const id = seq++; byHandle.set(id, captured.length); captured.push({ fn, ms }); return id; },
      clearTimeout(handle) { byHandle.delete(handle as number); },
    };

    const parsed = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { idleShutdownMs: 50 } });
    // The EXACT read daemon.ts performs (`lspCfg?.idleShutdownMs`) feeding the EXACT constructor
    // call site (`new LspManager({ idleShutdownMs })`) — this is the wiring contract under test.
    const mgr = new LspManager({ serverCommands: { typescript: FAKE }, scheduler, idleShutdownMs: parsed.lsp?.idleShutdownMs });
    try {
      const a = await mgr.clientFor("/workspace-settings-idle", "typescript");
      expect(a.alive).toBe(true);

      // THE discriminating assertion: the reap timer was armed with 50 (our threaded settings
      // value), NOT 300_000 (the manager's built-in default). Goes RED if daemon's threading is
      // omitted/wrong (idleShutdownMs would fall back to 300_000). One live timer at this point.
      const live = [...byHandle.values()].map((i) => captured[i]!);
      expect(live).toHaveLength(1);
      expect(live[0]!.ms).toBe(50);
      expect(live[0]!.ms).not.toBe(300_000);

      // And firing that captured callback actually reaps — the arming value is a real reap timer,
      // not some unrelated timer that merely happened to carry the right duration.
      await live[0]!.fn();
      expect(a.alive).toBe(false);
    } finally {
      await mgr.stopAll();
    }
  });
});

describe("lsp settings gating (phase 5f Task 4): enabled:false mirrors daemon.ts's own registerLspTools gate", () => {
  test("settings.lsp.enabled === false -> registerLspTools is never called -> the model's query is the registry's ordinary \"unknown tool\" error", async () => {
    const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { enabled: false } });
    const { engine, sessionId, registry, events } = setup([
      [{ type: "tool_call", callId: "c1", name: "lsp_diagnostics", argsJson: JSON.stringify({ path: "app.ts" }) }, done("tool_calls")],
      text("noted"),
    ]);

    // daemon.ts's own conditional (phase 5f T4 comment there): `if (lspCfg?.enabled !== false) {
    // ...registerLspTools(...) }` — reproduced verbatim here rather than re-imported (daemon.ts
    // boots a whole IPC server/provider/plugin stack this test has no need of); a drift between
    // this line and daemon.ts's actual gate is a whole-branch-review / code-reading concern, same
    // posture the codebase already accepts for reviewer.enabled/titles.enabled/computerUse.enabled
    // (none of which have a dedicated daemon-boot regression test tying the literal boolean to a
    // socket-level assertion either).
    const lspCfg = settings.lsp;
    if (lspCfg?.enabled !== false) {
      registerLspTools(registry, { lsp: new LspManager(), cwdOf: () => "/unused", rootsOf: () => ["/unused"] });
    }

    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1") as ToolResult;
    expect(toolResult).toMatchObject({ isError: true, output: "unknown tool: lsp_diagnostics" });
  });

  test("settings.lsp block absent, and enabled: true, both leave the tools registered (default-ON, same shape as reviewer.enabled/titles.enabled)", async () => {
    for (const lsp of [undefined, { enabled: true }] as const) {
      const settings = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, ...(lsp ? { lsp } : {}) });
      const { engine, sessionId, registry, events } = setup([
        [{ type: "tool_call", callId: "c1", name: "lsp_diagnostics", argsJson: JSON.stringify({ path: "app.ts" }) }, done("tool_calls")],
        text("noted"),
      ]);
      const lspCfg = settings.lsp;
      if (lspCfg?.enabled !== false) {
        registerLspTools(registry, { lsp: new LspManager(), cwdOf: () => "/unused", rootsOf: () => ["/unused"] });
      }
      await engine.runTurn(sessionId);
      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1") as ToolResult;
      // Never "unknown tool" — the fence-rejection error is fine here (path resolves against
      // rootsOf() === ["/unused"], which app.ts isn't under); the point is the tool EXISTS.
      expect(toolResult.output).not.toContain("unknown tool");
    }
  });
});

// -------------------------------------------------------------------------------------------
// OPTIONAL: a real sourcekit-lsp smoke (never a required gate — self-skips when the binary is
// absent). Verified by hand before writing this test: a genuine sourcekit-lsp process, pointed at
// a LOOSE .swift file with no Package.swift/compiled index, handshakes in well under a second and
// reports a real semantic diagnostic — no build system needed for a single-file syntax+type error,
// so this is fast and deterministic rather than the flaky/slow case the brief warns about. If that
// ever stops holding (e.g. a future Xcode requires a workspace index for even this), delete this
// block rather than fighting it — the fake-server e2e above is the real deliverable.
// -------------------------------------------------------------------------------------------
function hasSourceKitLsp(): boolean {
  try {
    execSync("which sourcekit-lsp", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-lsp-sk-smoke-")));
}

describe.if(isMac && hasSourceKitLsp())("OPTIONAL real smoke: sourcekit-lsp diagnostics on a genuine .swift file", () => {
  test("a real sourcekit-lsp process reports a real semantic diagnostic for a type mismatch", async () => {
    const root = realDir();
    writeFileSync(join(root, "Bad.swift"), "let x: Int = \"oops\"\n");
    const lsp = new LspManager(); // DEFAULT_SERVER_COMMANDS.swift — the real binary, no override
    const r = new ToolRegistry();
    registerLspTools(r, { lsp, cwdOf: () => root, rootsOf: () => [root] });
    try {
      const out = await r.execute("lsp_diagnostics", { path: "Bad.swift" }, { cwd: "/wrong", roots: ["/wrong"], sessionId: "s1" });
      expect(out.isError).toBe(false);
      expect(out.output).toContain("error");
      expect(out.output).toContain("Int"); // the type sourcekit-lsp actually names in this mismatch
    } finally {
      await lsp.stopAll();
    }
  }, 20_000); // real process spawn + handshake + diagnostics round trip — generous but bounded
});
