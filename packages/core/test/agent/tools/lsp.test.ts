import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { registerLspTools } from "../../../src/agent/tools/lsp";
import { LspClient } from "../../../src/agent/lsp/client";
import { LspManager } from "../../../src/agent/lsp/manager";

// Phase 5f Task 3: lsp_diagnostics/lsp_definition/lsp_references — the agent-facing surface over
// T1's LspClient + T2's LspManager. Fence discipline and the 1-based<->0-based position boundary
// are the two things worth pinning hardest here (see the brief's own framing); everything else
// (formatting/caps/empties) is straightforward golden-output coverage.

const FIXTURE = join(import.meta.dir, "../lsp/fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };
const isMac = process.platform === "darwin";

// Same pattern as client.test.ts's own withEnv: spawn() inherits the parent's env synchronously
// at the moment it's called (inside start(), before its first await), so setting/restoring env
// around an async `fn` is safe even though `finally` here runs before `fn`'s promise settles.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-lsp-tools-")));
}

function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// ctx.cwd/ctx.roots are DELIBERATELY wrong/unreachable dirs — proves the tools resolve cwd/roots
// via deps.cwdOf/deps.rootsOf(sessionId), never ctx.cwd/ctx.roots (mirrors memory-tools.test.ts's
// own ctx() convention and rationale).
const ctx = (sessionId: string) => ({ cwd: "/not-the-project-dir", roots: ["/nonexistent"], sessionId });

function setup() {
  const root = realDir();
  const outside = realDir(); // sibling dir, NEVER passed as a root — the fence-rejection target
  writeFileSync(join(outside, "secret.ts"), "const leaked = true;\n");
  writeFileSync(join(root, "usage.ts"), "import { target } from \"./target\";\ntarget();\n");
  writeFileSync(
    join(root, "target.ts"),
    "// line 0\n// line 1\n// line 2\nfunction target() {}\n// line 4\n",
  );
  mkdirSync(join(root, ".norma-tmp"), { recursive: true });
  const lsp = new LspManager({ serverCommands: { typescript: FAKE, swift: FAKE } });
  const r = new ToolRegistry();
  registerLspTools(r, { lsp, cwdOf: () => root, rootsOf: () => [root] });
  return { root, outside, lsp, r };
}

describe("lsp tools: pre-spawn guards (fence + language routing) — cross-platform, no process spawn", () => {
  test("fence rejection: an outside-roots path is a typed error, and clientFor is NEVER called", async () => {
    const { outside, lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp_diagnostics", { path: join(outside, "secret.ts") }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("outside the allowed directories");
    expect(spy).not.toHaveBeenCalled();
  });

  test("fence rejection applies to lsp_definition and lsp_references too — clientFor never called", async () => {
    const { outside, lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const defOut = await r.execute("lsp_definition", { path: join(outside, "secret.ts"), line: 1, character: 1 }, ctx("s1"));
    const refOut = await r.execute("lsp_references", { path: join(outside, "secret.ts"), line: 1, character: 1 }, ctx("s1"));
    expect(defOut.isError).toBe(true);
    expect(refOut.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test("unsupported extension: a typed error listing supported extensions, BEFORE clientFor", async () => {
    const { root, lsp, r } = setup();
    writeFileSync(join(root, "notes.md"), "hello\n");
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp_diagnostics", { path: "notes.md" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("unsupported");
    expect(out.output).toContain(".ts");
    expect(out.output).toContain(".swift");
    expect(spy).not.toHaveBeenCalled();
  });

  test("missing required args -> zod invalid-arguments typed error (no manager touch)", async () => {
    const { lsp, r } = setup();
    const spy = spyOn(lsp, "clientFor");
    const out = await r.execute("lsp_definition", { path: "a.ts" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for lsp_definition");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe.if(isMac)("lsp tools: happy-path formatting + position conversion (real fake-server)", () => {
  test("lsp_diagnostics: golden formatting — severities, source, no-source, empty", async () => {
    const { root, lsp, r } = setup();
    try {
      await withEnv({
        NORMA_LSP_FAKE_DIAGS: JSON.stringify([
          { range: { start: { line: 2, character: 4 } }, severity: 1, message: "Cannot find name 'foo'.", source: "tsserver" },
          { range: { start: { line: 5, character: 0 } }, severity: 2, message: "unused variable" },
        ]),
      }, async () => {
        const out = await r.execute("lsp_diagnostics", { path: "usage.ts" }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toBe(
          "error 3:5 Cannot find name 'foo'. [tsserver]\nwarn 6:1 unused variable",
        );
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_diagnostics: empty publish -> \"no diagnostics\" (not a timeout)", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: "[]" }, async () => {
        const out = await r.execute("lsp_diagnostics", { path: "usage.ts" }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no diagnostics" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_diagnostics: caps at 100 + \"+N more\"", async () => {
    const { lsp, r } = setup();
    try {
      const diags = Array.from({ length: 105 }, (_, i) => ({
        range: { start: { line: i, character: 0 } }, severity: 1, message: `err ${i}`,
      }));
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, async () => {
        const out = await r.execute("lsp_diagnostics", { path: "usage.ts" }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(101); // 100 shown + 1 summary line
        expect(lines[0]).toBe("error 1:1 err 0");
        expect(lines[99]).toBe("error 100:1 err 99");
        expect(lines[100]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_definition: model 10:5 queries LSP 9:4 (outgoing request pinned) AND the return formats 1-based with a preview", async () => {
    const { root, lsp, r } = setup();
    const defSpy = spyOn(LspClient.prototype, "definition");
    try {
      const targetPath = join(root, "target.ts");
      await withEnv({
        NORMA_LSP_FAKE_DEFINITION: JSON.stringify([
          { uri: toFileUri(targetPath), range: { start: { line: 3, character: 2 } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp_definition", { path: "usage.ts", line: 10, character: 5 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(defSpy).toHaveBeenCalledTimes(1);
        const [uriArg, textArg, lineArg, charArg] = defSpy.mock.calls[0]!;
        expect(uriArg).toBe(toFileUri(join(root, "usage.ts")));
        expect(typeof textArg).toBe("string"); // file text — the client opens the doc before querying
        expect(lineArg).toBe(9); // 10 (model, 1-based) - 1
        expect(charArg).toBe(4); // 5 (model, 1-based) - 1
        expect(out.output).toBe(`${targetPath}:4:3  function target() {}`);
      });
    } finally {
      defSpy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("lsp_definition: a returned location OUTSIDE the read fence gets no preview (never read off-fence)", async () => {
    const { root, outside, lsp, r } = setup();
    try {
      const offFencePath = join(outside, "secret.ts");
      await withEnv({
        NORMA_LSP_FAKE_DEFINITION: JSON.stringify([{ uri: toFileUri(offFencePath), range: { start: { line: 0, character: 0 } } }]),
      }, async () => {
        const out = await r.execute("lsp_definition", { path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(out.output).toBe(`${offFencePath}:1:1`); // location shown, but no preview text leaked
        expect(out.output).not.toContain("leaked");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_definition: caps at 50 + \"+N more\" (parity with diagnostics/references caps)", async () => {
    const { outside, lsp, r } = setup();
    try {
      // Point every location at an OFF-FENCE path so no per-location preview readFileSync runs —
      // the cap's slice+summary is what's under test, not preview formatting.
      const offFence = join(outside, "secret.ts");
      const defs = Array.from({ length: 55 }, (_, i) => ({
        uri: toFileUri(offFence), range: { start: { line: i, character: 0 } },
      }));
      await withEnv({ NORMA_LSP_FAKE_DEFINITION: JSON.stringify(defs) }, async () => {
        const out = await r.execute("lsp_definition", { path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(51); // 50 shown + 1 summary line
        expect(lines[0]).toBe(`${offFence}:1:1`);
        expect(lines[49]).toBe(`${offFence}:50:1`);
        expect(lines[50]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_definition: empty result -> \"no definition found\"", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_DEFINITION: "[]" }, async () => {
        const out = await r.execute("lsp_definition", { path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no definition found" });
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_references: model 2:1 queries LSP 1:0, golden formatting for a small result", async () => {
    const { root, lsp, r } = setup();
    const refSpy = spyOn(LspClient.prototype, "references");
    try {
      await withEnv({
        NORMA_LSP_FAKE_REFERENCES: JSON.stringify([
          { uri: toFileUri(join(root, "a.ts")), range: { start: { line: 1, character: 0 } } },
          { uri: toFileUri(join(root, "b.ts")), range: { start: { line: 5, character: 3 } } },
        ]),
      }, async () => {
        const out = await r.execute("lsp_references", { path: "usage.ts", line: 2, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        expect(refSpy).toHaveBeenCalledTimes(1);
        const [, , lineArg, charArg] = refSpy.mock.calls[0]!; // [uri, text, line, char]
        expect(lineArg).toBe(1);
        expect(charArg).toBe(0);
        expect(out.output).toBe(`${join(root, "a.ts")}:2:1\n${join(root, "b.ts")}:6:4`);
      });
    } finally {
      refSpy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("lsp_references: caps at 200 + \"+N more\"", async () => {
    const { root, lsp, r } = setup();
    try {
      const refs = Array.from({ length: 205 }, (_, i) => ({
        uri: toFileUri(join(root, "usage.ts")), range: { start: { line: i, character: 0 } },
      }));
      await withEnv({ NORMA_LSP_FAKE_REFERENCES: JSON.stringify(refs) }, async () => {
        const out = await r.execute("lsp_references", { path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out.isError).toBe(false);
        const lines = out.output.split("\n");
        expect(lines).toHaveLength(201); // 200 shown + 1 summary line
        expect(lines[0]).toBe(`${join(root, "usage.ts")}:1:1`);
        expect(lines[199]).toBe(`${join(root, "usage.ts")}:200:1`);
        expect(lines[200]).toBe("+5 more");
      });
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp_references: empty result -> \"no references found\"", async () => {
    const { lsp, r } = setup();
    try {
      await withEnv({ NORMA_LSP_FAKE_REFERENCES: "[]" }, async () => {
        const out = await r.execute("lsp_references", { path: "usage.ts", line: 1, character: 1 }, ctx("s1"));
        expect(out).toMatchObject({ isError: false, output: "no references found" });
      });
    } finally {
      await lsp.stopAll();
    }
  });
});
