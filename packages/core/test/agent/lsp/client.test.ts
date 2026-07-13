import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LspClient, LspTimeoutError, LspServerExitedError } from "../../../src/agent/lsp/client";

const FIXTURE = join(import.meta.dir, "fake-server.ts");
const isMac = process.platform === "darwin";
const ROOT_URI = "file:///workspace";

// `env` isn't part of the constructor's public cfg, so tests that need scenario env vars set
// process.env before spawning and restore it after — spawn() inherits the parent's env.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe.if(isMac)("LspClient", () => {
  test("handshake completes: start() resolves and client is alive", async () => {
    const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
    await c.start();
    expect(c.alive).toBe(true);
    await c.stop();
  });

  test("start() rejects on a typed timeout when the server never responds", async () => {
    const c = new LspClient({ command: "sleep", args: ["30"], rootUri: ROOT_URI, startTimeoutMs: 200 });
    await expect(c.start()).rejects.toThrow(LspTimeoutError);
    await c.stop(); // the child never responds to shutdown either; stop()'s own SIGKILL fallback covers this
  }, 8000);

  test("diagnostics(): non-empty publish resolves with the canned diagnostics", async () => {
    await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 3, character: 1 }, end: { line: 3, character: 5 } }, severity: 2, message: "unused var", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/a.ts", "const x = 1;", 2000);
      expect(diags).toEqual([{ line: 3, character: 1, severity: 2, message: "unused var", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): an empty publish resolves to [] — a valid answer, not a timeout", async () => {
    await withEnv({ NORMA_LSP_FAKE_DIAGS: "[]" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/clean.ts", "const y = 1;", 2000);
      expect(diags).toEqual([]);
      await c.stop();
    });
  });

  test("diagnostics(): staged publishes (empty syntactic pass, then the semantic pass) resolve with the SETTLED result, not the first publish", async () => {
    // Real tsserver shape: a fast (often empty) syntactic publish lands first; the semantic pass
    // follows ~100ms later as a SECOND publish for the same uri. Resolve-on-first-publish returns
    // "no diagnostics" for a file whose only problem is a TYPE error — the exact live failure this
    // settle window exists to prevent.
    await withEnv({ NORMA_LSP_FAKE_STAGED_DIAGS: "1", NORMA_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 250 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/typed.ts", "const n: number = \"s\";", 3000);
      expect(diags).toEqual([{ line: 0, character: 6, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): the overall deadline returns the LATEST publish when the settle window can't elapse in time", async () => {
    // settle window (5s) deliberately larger than the overall timeout (600ms): both staged
    // publishes land (~0ms and ~100ms), the settle timer never gets to fire, and the deadline
    // must resolve with the latest data rather than throwing — data beats a timeout error.
    await withEnv({ NORMA_LSP_FAKE_STAGED_DIAGS: "1", NORMA_LSP_FAKE_DIAGS: JSON.stringify([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, severity: 1, message: "late but real", source: "fake-lsp" },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 5000 });
      await c.start();
      const diags = await c.diagnostics("file:///workspace/churn.ts", "x", 600);
      expect(diags).toEqual([{ line: 1, character: 0, severity: 1, message: "late but real", source: "fake-lsp" }]);
      await c.stop();
    });
  });

  test("diagnostics(): no publish ever arrives → rejects with a typed timeout", async () => {
    await withEnv({ NORMA_LSP_FAKE_NO_DIAGNOSTICS: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.diagnostics("file:///workspace/silent.ts", "x", 150)).rejects.toThrow(LspTimeoutError);
      await c.stop();
    });
  });

  test("definition(): round-trips the canned location, 0-based through", async () => {
    await withEnv({ NORMA_LSP_FAKE_DEFINITION: JSON.stringify([
      { uri: "file:///workspace/def.ts", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.definition("file:///workspace/a.ts", "const x = 1;", 4, 6);
      expect(locs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      await c.stop();
    });
  });

  test("references(): round-trips the canned locations", async () => {
    await withEnv({ NORMA_LSP_FAKE_REFERENCES: JSON.stringify([
      { uri: "file:///workspace/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      { uri: "file:///workspace/b.ts", range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
    ]) }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.references("file:///workspace/a.ts", "const x = 1;", 1, 0);
      expect(locs).toEqual([
        { path: "/workspace/a.ts", line: 1, character: 0 },
        { path: "/workspace/b.ts", line: 5, character: 3 },
      ]);
      await c.stop();
    });
  });

  test("definition()/references(): the target document is didOpen'd before the query — a server that only answers for open docs still resolves", async () => {
    // Real servers (tsserver, sourcekit-lsp) return null for a position query on a document they
    // were never handed. The old code never opened the doc for definition/references, so this
    // returned nothing live even though the fake server (which answered regardless) stayed green.
    await withEnv({
      NORMA_LSP_FAKE_REQUIRE_OPEN: "1",
      NORMA_LSP_FAKE_DEFINITION: JSON.stringify([{ uri: "file:///workspace/target.ts", range: { start: { line: 7, character: 0 }, end: { line: 7, character: 4 } } }]),
      NORMA_LSP_FAKE_REFERENCES: JSON.stringify([{ uri: "file:///workspace/ref.ts", range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } } }]),
    }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 100 });
      await c.start();
      const def = await c.definition("file:///workspace/src.ts", "const y = 1;", 0, 6);
      expect(def).toEqual([{ path: "/workspace/target.ts", line: 7, character: 0 }]);
      const refs = await c.references("file:///workspace/src2.ts", "const z = 2;", 0, 6);
      expect(refs).toEqual([{ path: "/workspace/ref.ts", line: 2, character: 1 }]);
      await c.stop();
    });
  });

  test("split-write: a response body split across two stdout writes reassembles correctly", async () => {
    await withEnv({ NORMA_LSP_FAKE_SPLIT: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      const locs = await c.definition("file:///workspace/a.ts", "x", 0, 0);
      expect(locs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      await c.stop();
    });
  });

  test("merged frames: two complete frames delivered in one chunk both dispatch", async () => {
    await withEnv({ NORMA_LSP_FAKE_MERGE: "1" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI, diagSettleMs: 50 });
      await c.start();
      // Prime the doc first so both position queries skip the ensure-open gate and issue their
      // requests in order (definition then references) — the ordering the fake's merge relies on.
      await c.diagnostics("file:///workspace/a.ts", "x", 2000);
      // The fake server holds the definition response until references arrives, then writes
      // BOTH frames concatenated in a single stdout.write() — both promises must still resolve.
      const [defs, refs] = await Promise.all([
        c.definition("file:///workspace/a.ts", "x", 0, 0),
        c.references("file:///workspace/a.ts", "x", 1, 0),
      ]);
      expect(defs).toEqual([{ path: "/workspace/def.ts", line: 9, character: 2 }]);
      expect(refs).toEqual([
        { path: "/workspace/a.ts", line: 1, character: 0 },
        { path: "/workspace/b.ts", line: 5, character: 3 },
      ]);
      await c.stop();
    });
  });

  test("server death mid-request rejects the pending request with a typed error", async () => {
    await withEnv({ NORMA_LSP_FAKE_DIE_ON: "textDocument/definition" }, async () => {
      const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
      await c.start();
      await expect(c.definition("file:///workspace/a.ts", "x", 0, 0)).rejects.toThrow(LspServerExitedError);
      expect(c.alive).toBe(false);
      await c.stop(); // must not hang/throw even though the child is already gone
    });
  });

  test("stop(): clean shutdown resolves and marks the client dead", async () => {
    const c = new LspClient({ command: "bun", args: ["run", FIXTURE], rootUri: ROOT_URI });
    await c.start();
    expect(c.alive).toBe(true);
    await c.stop();
    expect(c.alive).toBe(false);
  });
});
