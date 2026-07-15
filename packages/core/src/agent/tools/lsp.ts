import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ToolRegistry } from "./registry";
import { resolveWithinAny } from "../paths";
import { LspManager, languageForPath, type LspLanguage } from "../lsp/manager";
import type { LspDiagnostic, LspLocation } from "../lsp/client";

/**
 * lsp_diagnostics / lsp_definition / lsp_references (phase 5f Task 3) — the agent-facing surface
 * over T2's LspManager (lazy per-(workspaceRoot, language) server lifecycle) + T1's LspClient
 * (0-based stdio protocol client). PLAIN TOOLS, same shape as memory.ts/agent-query.ts (deps
 * closure at registration, `ctx.sessionId` at run time) — nothing here needs the engine's dispatch
 * loop. ALL THREE ARE READ_ONLY (gate.ts) and `deferred: true` (agent-query.ts's precedent).
 *
 * `cwdOf`/`rootsOf`/`tmpDirOf` are deps closures, NOT `ctx.cwd`/`ctx.roots`/`ctx.tmpDir` — same
 * rationale as memory.ts's `cwdOf`: `ctx.cwd`/`ctx.roots` are the CURRENT THREAD's (which for an
 * isolated worktree child can diverge from the session's own project directory), whereas these
 * resolve the SESSION's real cwd/roots (daemon.ts wires them from the identical `store.meta(sid)`/
 * `sessionDirs.roots(sid)`/`sessionTmpDir(sid)` sources memory/fs-read already use).
 *
 * FENCE DISCIPLINE (the security lens for this file): every tool resolves `path` against the
 * session's read roots via `resolveWithinAny` BEFORE anything else — in particular before
 * `clientFor`, so a rejected path never spawns or reuses a language server (a test spies the
 * manager and asserts zero `clientFor` calls on a fence rejection). Language routing
 * (`languageForPath` — unsupported extension is ALSO a pre-`clientFor` typed error) runs second,
 * after the fence check, so both guards are provably ahead of any manager interaction.
 *
 * That same fence is re-applied to `lsp_definition`'s returned locations before reading a disk
 * preview (see `formatDefinition` below): a location the language server reports OUTSIDE the
 * session's roots still gets listed (path:line:col), but never previewed. Without this, a
 * compromised or buggy language server could return an arbitrary absolute path (e.g. "/etc/passwd")
 * and turn this tool into a read-any-file oracle that bypasses the exact fence its OWN `path` arg
 * argument is held to.
 *
 * POSITION CONVENTION (the other binding constraint): every tool's `line`/`character` args are
 * 1-based (the model/human editor convention — stated in each tool's description); LspClient is
 * 0-based throughout (client.ts's own doc comment). Subtract 1 before calling the client, add 1
 * back when formatting a returned location — both directions are pinned by this file's own tests.
 *
 * CALLER CONTRACT (T2's own docstring on `clientFor`): the idle-reap timer rearms on `clientFor`
 * itself, not on each query — so every tool calls `clientFor` fresh, immediately before its query,
 * rather than caching a client across a call boundary.
 */

// EXTENSION_LANGUAGE's key set (agent/lsp/manager.ts) is not exported — this is a small,
// display-only duplicate so the "unsupported extension" error can name them. Keep in sync with
// that map if a language is ever added there.
const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".swift"];

const DIAGNOSTICS_CAP = 100;
const REFERENCES_CAP = 200;
// Definitions are capped lower than references (50 vs 200) because each shown definition does a
// fenced readFileSync for its one-line preview — an unbounded pathological server returning many
// locations would otherwise force one disk read apiece. Parity with the diagnostics/references caps.
const DEFINITIONS_CAP = 50;
const PREVIEW_MAX = 200; // one-line preview text is length-capped, not just line-capped

function severityWord(sev: 1 | 2 | 3 | 4): "error" | "warn" | "info" | "hint" {
  switch (sev) {
    case 1: return "error";
    case 2: return "warn";
    case 3: return "info";
    case 4: return "hint";
    default: return "info"; // defensive: an out-of-range severity from a nonconforming server
  }
}

// LSP's wire format: file:// + encodeURI (NOT encodeURIComponent — leaves "/" untouched), the SAME
// choice manager.ts's own (unexported) pathToFileUri makes, so client.ts's uriToPath round-trips it.
function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// The session tmp dir is a Norma-managed, session-private read root, same allowance fs-read.ts's
// own readRootsOf grants — duplicated here (not imported) because that version closes over
// ToolContext's roots/tmpDir, while this file's tools resolve both via deps closures instead.
function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

function oneLinePreview(absPath: string, line0: number): string | undefined {
  try {
    const lines = readFileSync(absPath, "utf8").split("\n");
    const raw = lines[line0];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX) + "…" : trimmed;
  } catch {
    return undefined; // file unreadable/vanished since the server reported it — omit the preview, still show the location
  }
}

function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return "no diagnostics";
  const shown = diags.slice(0, DIAGNOSTICS_CAP).map((d) => {
    const src = d.source ? ` [${d.source}]` : "";
    return `${severityWord(d.severity)} ${d.line + 1}:${d.character + 1} ${d.message}${src}`;
  });
  const extra = diags.length - DIAGNOSTICS_CAP;
  return extra > 0 ? `${shown.join("\n")}\n+${extra} more` : shown.join("\n");
}

// Only definition locations get a preview (references do not — see this file's doc comment and
// the brief's formatting spec). `readRoots` re-applies the SAME fence the tool's own `path` arg is
// held to (see FENCE DISCIPLINE above) — a location outside it is still listed, just never read.
function formatDefinition(locs: LspLocation[], readRoots: string[]): string {
  if (locs.length === 0) return "no definition found";
  const lines = locs.slice(0, DEFINITIONS_CAP).map((loc) => {
    const base = `${loc.path}:${loc.line + 1}:${loc.character + 1}`;
    let safe: string | undefined;
    try { safe = resolveWithinAny(readRoots, loc.path); } catch { /* outside the fence: no preview, location still shown */ }
    const prev = safe ? oneLinePreview(safe, loc.line) : undefined;
    return prev ? `${base}  ${prev}` : base;
  });
  const extra = locs.length - DEFINITIONS_CAP;
  return extra > 0 ? `${lines.join("\n")}\n+${extra} more` : lines.join("\n");
}

function formatReferences(locs: LspLocation[]): string {
  if (locs.length === 0) return "no references found";
  const shown = locs.slice(0, REFERENCES_CAP).map((loc) => `${loc.path}:${loc.line + 1}:${loc.character + 1}`);
  const extra = locs.length - REFERENCES_CAP;
  return extra > 0 ? `${shown.join("\n")}\n+${extra} more` : shown.join("\n");
}

export interface LspToolDeps {
  lsp: LspManager;
  cwdOf: (sessionId: string) => string | undefined;
  rootsOf: (sessionId: string) => string[];
  tmpDirOf?: (sessionId: string) => string | undefined;
}

export function registerLspTools(r: ToolRegistry, deps: LspToolDeps): void {
  const { lsp, cwdOf, rootsOf, tmpDirOf } = deps;

  // Shared prelude for all three tools: fence-check `path` BEFORE anything else touches the
  // manager, THEN route its language (unsupported → typed error) — also before `clientFor`. Only
  // once both guards pass does a caller get a workspace root to spawn/reuse a server against.
  function resolvePathAndLanguage(sessionId: string, path: string): { abs: string; cwd: string; language: LspLanguage; readRoots: string[] } {
    const readRoots = readRootsOf(rootsOf(sessionId), tmpDirOf?.(sessionId));
    const abs = resolveWithinAny(readRoots, path); // throws BEFORE clientFor on an outside-roots path
    const language = languageForPath(abs);
    if (!language) {
      throw new Error(`unsupported file extension for LSP: "${path}" (supported: ${SUPPORTED_EXTENSIONS.join(", ")})`);
    }
    const cwd = cwdOf(sessionId);
    if (!cwd) throw new Error("no working directory for this session");
    return { abs, cwd, language, readRoots };
  }

  r.register({
    name: "lsp_diagnostics",
    description:
      "Get language-server diagnostics (errors/warnings) for a file. path is relative to the session directory. " +
      "Supported: .ts/.tsx/.js/.jsx/.mts/.cts/.swift.",
    args: z.object({ path: z.string().min(1) }),
    deferred: true,
    async run({ path }, { sessionId }) {
      const { abs, cwd, language } = resolvePathAndLanguage(sessionId, path);
      const client = await lsp.clientFor(cwd, language); // re-acquired fresh every call — see CALLER CONTRACT above
      const text = readFileSync(abs, "utf8");
      const diags = await client.diagnostics(toFileUri(abs), text);
      return formatDiagnostics(diags);
    },
  });

  r.register({
    name: "lsp_definition",
    description:
      "Find the definition of the symbol at a position. line/character are 1-based (like most editors). " +
      "path is relative to the session directory. Supported: .ts/.tsx/.js/.jsx/.mts/.cts/.swift.",
    args: z.object({ path: z.string().min(1), line: z.number().int().min(1), character: z.number().int().min(1) }),
    deferred: true,
    async run({ path, line, character }, { sessionId }) {
      const { abs, cwd, language, readRoots } = resolvePathAndLanguage(sessionId, path);
      const client = await lsp.clientFor(cwd, language);
      const text = readFileSync(abs, "utf8"); // the client opens the doc before querying — servers only answer for open docs
      const locs = await client.definition(toFileUri(abs), text, line - 1, character - 1); // 1-based tool args -> 0-based client
      return formatDefinition(locs, readRoots);
    },
  });

  r.register({
    name: "lsp_references",
    description:
      "Find references to the symbol at a position. line/character are 1-based (like most editors). " +
      "path is relative to the session directory. Supported: .ts/.tsx/.js/.jsx/.mts/.cts/.swift.",
    args: z.object({ path: z.string().min(1), line: z.number().int().min(1), character: z.number().int().min(1) }),
    deferred: true,
    async run({ path, line, character }, { sessionId }) {
      const { abs, cwd, language } = resolvePathAndLanguage(sessionId, path);
      const client = await lsp.clientFor(cwd, language);
      const text = readFileSync(abs, "utf8");
      const locs = await client.references(toFileUri(abs), text, line - 1, character - 1);
      return formatReferences(locs);
    },
  });
}
