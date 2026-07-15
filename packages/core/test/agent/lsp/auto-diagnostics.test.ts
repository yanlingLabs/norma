import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LspManager } from "../../../src/agent/lsp/manager";
import { LspManager as RealLspManager } from "../../../src/agent/lsp/manager";
import { autoDiagnosticsSuffix, AUTO_DIAG_TOOL_NAMES } from "../../../src/agent/lsp/auto-diagnostics";

// lsp-consolidation T3 (design doc `2026-07-15-lsp-consolidation-design.md` §2): unit tests for
// `autoDiagnosticsSuffix` itself, split two ways —
//   1. real fake-server integration (mirrors lsp-e2e.test.ts's own FAKE harness): proves the
//      format/order/cap contract against the REAL settle machinery (LspManager -> LspClient ->
//      textDocument/publishDiagnostics), gated `describe.if(isMac)` like every other fake-server
//      test in this repo.
//   2. never-fail behavior: cheap duck-typed `LspManager` doubles (cast, no real process spawned)
//      proving every failure mode — unsupported extension, fence rejection, a spawn/timeout/crash
//      thrown from ANYWHERE in the LSP call chain, a malformed `args` shape — resolves to "" and
//      NEVER throws. These do not need `isMac` (no real subprocess involved) and run everywhere.

const isMac = process.platform === "darwin";
const FIXTURE = join(import.meta.dir, "fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };

// Same pattern as lsp-e2e.test.ts's own withEnv: awaits `fn` BEFORE restoring so the env vars stay
// set for the whole async call (clientFor's spawn + the diagnostics round trip), not just its
// first synchronous slice.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function freshDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-auto-diag-")));
}

describe("AUTO_DIAG_TOOL_NAMES", () => {
  test("exactly write/edit/notebook_edit — the only tools the engine's post-execute hook fires for", () => {
    expect([...AUTO_DIAG_TOOL_NAMES].sort()).toEqual(["edit", "notebook_edit", "write"]);
  });
});

describe.if(isMac)("autoDiagnosticsSuffix: real fake-server integration", () => {
  test("clean file (server publishes zero diagnostics) -> '' — silence = clean, no token waste", async () => {
    const root = freshDir();
    writeFileSync(join(root, "clean.ts"), "const x = 1;\n");
    const lsp = new RealLspManager({ serverCommands: { typescript: FAKE } });
    try {
      const out = await withEnv({ NORMA_LSP_FAKE_DIAGS: "[]" }, () =>
        autoDiagnosticsSuffix({ lsp, toolName: "write", args: { path: "clean.ts" }, cwd: root, roots: [root] }));
      expect(out).toBe("");
    } finally {
      await lsp.stopAll();
    }
  });

  test("errors + warnings -> formatted block, errors FIRST regardless of the server's own publish order", async () => {
    const root = freshDir();
    writeFileSync(join(root, "bad.ts"), "let x = 1;\n");
    const lsp = new RealLspManager({ serverCommands: { typescript: FAKE } });
    // Server publishes the WARNING first, error second — the formatted block must still put the
    // error first (spec: "errors first"), proving this is a real reorder, not an accident of
    // publish order.
    const diags = [
      { range: { start: { line: 4, character: 1 } }, severity: 2, message: "unused var", source: "tsserver" },
      { range: { start: { line: 1, character: 2 } }, severity: 1, message: "type mismatch", source: "tsserver" },
    ];
    try {
      const out = await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () =>
        autoDiagnosticsSuffix({ lsp, toolName: "edit", args: { path: "bad.ts" }, cwd: root, roots: [root] }));
      expect(out).toBe(
        "\n\ndiagnostics (1 errors, 1 warnings):\n" +
        "bad.ts:2:3 error type mismatch\n" +
        "bad.ts:5:2 warn unused var",
      );
    } finally {
      await lsp.stopAll();
    }
  });

  test("cap at 20 entries + trailing '…and K more', header counts the FULL total (not just shown)", async () => {
    const root = freshDir();
    writeFileSync(join(root, "many.ts"), "x\n".repeat(30));
    const lsp = new RealLspManager({ serverCommands: { typescript: FAKE } });
    const diags = Array.from({ length: 25 }, (_, i) => ({
      range: { start: { line: i, character: 0 } }, severity: 1 as const, message: `err ${i}`,
    }));
    try {
      const out = await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () =>
        autoDiagnosticsSuffix({ lsp, toolName: "write", args: { path: "many.ts" }, cwd: root, roots: [root] }));
      expect(out.startsWith("\n\ndiagnostics (25 errors, 0 warnings):\n")).toBe(true);
      expect(out.endsWith("…and 5 more")).toBe(true);
      const entryLines = out.split("\n").filter((l) => l.startsWith("many.ts:"));
      expect(entryLines).toHaveLength(20);
    } finally {
      await lsp.stopAll();
    }
  });

  test("notebook_edit reads its file path from `notebook_path` (not `path`)", async () => {
    const root = freshDir();
    writeFileSync(join(root, "app.ts"), "const x = 1;\n");
    const lsp = new RealLspManager({ serverCommands: { typescript: FAKE } });
    const diags = [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" }];
    try {
      const out = await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () =>
        autoDiagnosticsSuffix({ lsp, toolName: "notebook_edit", args: { notebook_path: "app.ts" }, cwd: root, roots: [root] }));
      expect(out).toBe("\n\ndiagnostics (1 errors, 0 warnings):\napp.ts:1:1 error boom");
    } finally {
      await lsp.stopAll();
    }
  });

  test("abort mid-diagnostics-wait -> '' PROMPTLY (well under the diag timeout), write result intact (whole-branch review fast-follow)", async () => {
    const root = freshDir();
    writeFileSync(join(root, "slow.ts"), "const x = 1;\n");
    // The server NEVER publishes (NORMA_LSP_FAKE_NO_DIAGNOSTICS) — without the abort race, this
    // call would ride out the FULL per-language deadline (DIAG_TUNING.typescript.timeoutMs = 8s,
    // the manager's default wiring). Pre-warm the client OUTSIDE the timed window so the abort
    // deterministically lands mid-DIAGNOSTICS-wait, not mid-spawn.
    const lsp = new RealLspManager({ serverCommands: { typescript: FAKE } });
    try {
      await withEnv({ NORMA_LSP_FAKE_NO_DIAGNOSTICS: "1" }, async () => {
        await lsp.clientFor(root, "typescript"); // pre-warm
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 100);
        const startedAt = Date.now();
        const out = await autoDiagnosticsSuffix({
          lsp, toolName: "write", args: { path: "slow.ts" }, cwd: root, roots: [root], signal: ac.signal,
        });
        const elapsed = Date.now() - startedAt;
        expect(out).toBe(""); // never-fail: the write result stays exactly what the tool returned
        expect(elapsed).toBeLessThan(2000); // resolved at the ~100ms abort, nowhere near the 8s deadline
      });
    } finally {
      await lsp.stopAll();
    }
  });
});

describe("autoDiagnosticsSuffix: never-fail contract (no real process spawned)", () => {
  // A double that throws the instant it's touched — proves the gate rejected the call BEFORE ever
  // reaching the manager, not merely that a later step happened to also fail safely.
  const untouchableLsp = { clientFor: () => { throw new Error("clientFor must never be called"); } } as unknown as LspManager;

  test("unknown tool name -> '' , lsp never touched", async () => {
    const root = freshDir();
    writeFileSync(join(root, "app.ts"), "x\n");
    const out = await autoDiagnosticsSuffix({ lsp: untouchableLsp, toolName: "bash", args: { path: "app.ts" }, cwd: root, roots: [root] });
    expect(out).toBe("");
  });

  test("missing file-path arg -> '' , lsp never touched", async () => {
    const out = await autoDiagnosticsSuffix({ lsp: untouchableLsp, toolName: "write", args: {}, cwd: "/tmp", roots: ["/tmp"] });
    expect(out).toBe("");
  });

  test("non-string file-path arg -> '' , lsp never touched", async () => {
    const out = await autoDiagnosticsSuffix({ lsp: untouchableLsp, toolName: "write", args: { path: 42 }, cwd: "/tmp", roots: ["/tmp"] });
    expect(out).toBe("");
  });

  test("null args -> '' , lsp never touched", async () => {
    const out = await autoDiagnosticsSuffix({ lsp: untouchableLsp, toolName: "write", args: null, cwd: "/tmp", roots: ["/tmp"] });
    expect(out).toBe("");
  });

  test("unsupported extension (no configured language server) -> '' , lsp never touched", async () => {
    const root = freshDir();
    writeFileSync(join(root, "notes.md"), "# hi\n");
    const out = await autoDiagnosticsSuffix({ lsp: untouchableLsp, toolName: "write", args: { path: "notes.md" }, cwd: root, roots: [root] });
    expect(out).toBe("");
  });

  test("path outside every fence root -> '' , lsp never touched (the SAME fence write/edit are held to)", async () => {
    const root = freshDir();
    const outside = freshDir();
    writeFileSync(join(outside, "escaped.ts"), "x\n");
    const out = await autoDiagnosticsSuffix({
      lsp: untouchableLsp, toolName: "write", args: { path: join(outside, "escaped.ts") }, cwd: root, roots: [root],
    });
    expect(out).toBe("");
  });

  test("LspManager.clientFor rejects (spawn failure / dead server) -> '' , write result untouched", async () => {
    const root = freshDir();
    writeFileSync(join(root, "app.ts"), "x\n");
    const spawnFailingLsp = { clientFor: async () => { throw new Error("failed to start"); } } as unknown as LspManager;
    const out = await autoDiagnosticsSuffix({ lsp: spawnFailingLsp, toolName: "write", args: { path: "app.ts" }, cwd: root, roots: [root] });
    expect(out).toBe("");
  });

  test("client.diagnostics rejects (server timeout) -> '' , write result untouched", async () => {
    const root = freshDir();
    writeFileSync(join(root, "app.ts"), "x\n");
    const timeoutLsp = {
      clientFor: async () => ({ diagnostics: async () => { throw new Error("diagnostics timed out"); } }),
    } as unknown as LspManager;
    const out = await autoDiagnosticsSuffix({ lsp: timeoutLsp, toolName: "write", args: { path: "app.ts" }, cwd: root, roots: [root] });
    expect(out).toBe("");
  });

  test("signal ALREADY aborted at entry -> '' , lsp never touched (no cold-spawn for an interrupted turn)", async () => {
    const root = freshDir();
    writeFileSync(join(root, "app.ts"), "x\n");
    const ac = new AbortController();
    ac.abort();
    const out = await autoDiagnosticsSuffix({
      lsp: untouchableLsp, toolName: "write", args: { path: "app.ts" }, cwd: root, roots: [root], signal: ac.signal,
    });
    expect(out).toBe("");
  });
});
