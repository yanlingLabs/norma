import { readFileSync } from "node:fs";
import type { LspManager } from "./manager";
import { languageForPath } from "./manager";
import type { LspDiagnostic } from "./client";
import { resolveWithinAny } from "../paths";

/**
 * Auto-diagnostics after edit (lsp-consolidation T3, design doc `2026-07-15-lsp-consolidation-
 * design.md` §2) — CC parity: "after each file edit, it automatically reports type errors and
 * warnings so Claude can fix issues without a separate build step." This is NOT a second
 * diagnostics pipeline: it calls the SAME `LspManager.clientFor` / `LspClient.diagnostics()` the
 * on-demand `lsp` tool's `diagnostics` action already rides (tools/lsp.ts), which is what makes it
 * automatically bounded by the SAME per-language settle/timeout tuning (`DIAG_TUNING`, manager.ts)
 * with no extra tuning of its own.
 *
 * NEVER-FAIL CONTRACT (why this whole thing is one try/catch): the write/edit/notebook_edit call
 * that triggers this already SUCCEEDED — engine.ts only calls this after confirming
 * `!isError`. A diagnostics hiccup (unsupported extension, fence rejection, spawn failure,
 * timeout, dead server, a malformed `args` shape) must never retroactively touch that already-
 * returned tool_result. Every failure mode below resolves to "" (append nothing); NOTHING here
 * ever throws out to the caller.
 */

// Tool name -> which arg key holds the file path that was just written. Only write/edit/
// notebook_edit ever reach this function at all (engine.ts's own AUTO_DIAG_TOOL_NAMES gate runs
// first) — every other tool call skips this file entirely. write/edit share the same fs-write.ts
// schema (`path`); notebook_edit's own schema (notebook.ts) calls the same concept `notebook_path`.
const FILE_PATH_ARG: Record<string, string> = {
  write: "path",
  edit: "path",
  notebook_edit: "notebook_path",
};

/** The tool names this hook ever applies to — exported so engine.ts's post-execute gate and this
 *  module's own path-arg lookup can never drift apart (one Set, one source of truth). */
export const AUTO_DIAG_TOOL_NAMES = new Set(Object.keys(FILE_PATH_ARG));

const AUTO_DIAG_CAP = 20;

// LSP's wire format: file:// + encodeURI (NOT encodeURIComponent — leaves "/" untouched), the SAME
// choice tools/lsp.ts's own (module-local) toFileUri makes — duplicated rather than imported,
// same "small one-line helper, not worth coupling two files over" precedent as that file's own
// readRootsOf doc comment.
function toFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

// Mirrors tools/lsp.ts's own severityWord (module-local there too, not exported) — same four-way
// mapping, kept in sync by hand if the LSP DiagnosticSeverity enum ever changes (it hasn't since
// LSP 3.x shipped).
function severityWord(sev: 1 | 2 | 3 | 4): "error" | "warn" | "info" | "hint" {
  switch (sev) {
    case 1: return "error";
    case 2: return "warn";
    case 3: return "info";
    case 4: return "hint";
    default: return "info"; // defensive: an out-of-range severity from a nonconforming server
  }
}

// Design decision (flagged for review): the spec's header format is binary — "(<n> errors, <m>
// warnings)" — with no third/fourth bucket for LSP's Information/Hint severities. `errors` counts
// ONLY severity 1; every other severity (2 warning, 3 information, 4 hint) is folded into the
// `warnings` count for the header, though each entry line still shows its OWN real severity word
// (warn/info/hint) so no information is lost — only the two-bucket HEADER TOTAL is a simplification.
// Ordering: errors first (the spec's explicit requirement), then everything else in its original
// relative (server-reported) order — a stable partition, not a full re-sort by exact severity.
function formatBlock(displayPath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return ""; // clean file — CC parity: silence = clean, no token waste
  const errors = diags.filter((d) => d.severity === 1);
  const rest = diags.filter((d) => d.severity !== 1);
  const ordered = [...errors, ...rest];
  const shown = ordered
    .slice(0, AUTO_DIAG_CAP)
    .map((d) => `${displayPath}:${d.line + 1}:${d.character + 1} ${severityWord(d.severity)} ${d.message}`);
  const extra = ordered.length - AUTO_DIAG_CAP;
  const list = extra > 0 ? `${shown.join("\n")}\n…and ${extra} more` : shown.join("\n");
  // `rest.length` DELIBERATELY folds severities 3/4 (info/hint) into the "warnings" count — the
  // header is two-bucket by spec; entry lines above keep their true severity word. Don't "fix".
  return `\n\ndiagnostics (${errors.length} errors, ${rest.length} warnings):\n${list}`;
}

export interface AutoDiagnosticsOpts {
  lsp: LspManager;
  toolName: string; // one of AUTO_DIAG_TOOL_NAMES — anything else returns "" immediately
  args: unknown; // the tool call's already-parsed args (JSON.parse'd by executeCall)
  cwd: string; // workspace root to spawn/reuse the language server against (executeCall's own `cwd`)
  roots: string[]; // fence roots the file path is resolved against (executeCall's own `roots`)
  // The TURN's abort signal (executeCall's own `signal` — whole-branch review fast-follow): an
  // ESC/interrupt mid-diagnostics-wait must not delay the visible abort by up to the per-language
  // diag timeout (30s for Swift). Optional — absent (a caller/test that doesn't care) behaves
  // exactly as before this was added.
  signal?: AbortSignal;
}

/** Rejects the moment `signal` aborts (or immediately if it already has) — raced against the
 *  spawn/diagnostics waits below so an interrupt cuts this suffix short WITHOUT touching
 *  LspClient (whose `diagnostics()` has no signal parameter; the abandoned promise self-cleans
 *  via the client's own settle/deadline timers, and Promise.race already attached a handler to
 *  it, so a late rejection is never unhandled). The abort listener is removed in `finally`
 *  either way: the turn's signal outlives this call, so a leaked once-listener per edit would
 *  otherwise accumulate for the whole turn. */
async function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("turn aborted"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Returns the block to APPEND to a write/edit/notebook_edit tool_result, or "" when there is
 *  nothing to append — see this file's own NEVER-FAIL CONTRACT doc comment above. */
export async function autoDiagnosticsSuffix(opts: AutoDiagnosticsOpts): Promise<string> {
  try {
    const argKey = FILE_PATH_ARG[opts.toolName];
    if (!argKey) return "";
    const filePath = (opts.args as Record<string, unknown> | null | undefined)?.[argKey];
    if (typeof filePath !== "string" || !filePath) return "";
    const language = languageForPath(filePath);
    if (!language) return ""; // extension has no configured language server (e.g. .ipynb, .md)
    const abs = resolveWithinAny(opts.roots, filePath); // the SAME fence the write/edit itself was held to
    if (opts.signal?.aborted) return ""; // already interrupted — don't even cold-spawn a server
    const client = await raceAbort(opts.lsp.clientFor(opts.cwd, language), opts.signal); // may cold-spawn; bounded by startTimeoutMs
    const text = readFileSync(abs, "utf8");
    // Bounded by DIAG_TUNING[language] AND raced against the turn's abort — an interrupt resolves
    // "" promptly (raceAbort's rejection lands in this function's never-fail catch below) instead
    // of riding out the full settle/timeout window.
    const diags = await raceAbort(client.diagnostics(toFileUri(abs), text), opts.signal);
    return formatBlock(filePath, diags);
  } catch {
    return ""; // never-fail — see this file's own doc comment
  }
}
