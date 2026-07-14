import { z } from "zod";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonAncestor, resolveWithinAny } from "../paths";
import type { ToolRegistry } from "./registry";

const LS_MAX_ENTRIES = 1000;

const DENY_MESSAGE = "this path is Norma's own credential store and is never readable";

/**
 * Reads-unrestricted (user rule, memory/reads-unrestricted.md, task-10): read/ls/glob/grep have NO
 * path fence — the write fence (fs-write.ts) is a completely separate, unchanged mechanism. The
 * ONE carve-out is this denylist: a small set of real, realpath-resolved directory prefixes that
 * hold Norma's OWN credential/runtime material, so a prompt-injected turn can't read the daemon's
 * own keys through the tool the daemon itself hosts. Everything else under ~/.norma (sessions,
 * settings, memory, logs, skills, ...) is readable by design — this is NOT a general sandbox.
 */
export interface ReadToolsConfig {
  /** Directories to deny, checked via a symlink-hardened prefix match (canonAncestor) so a symlink
   *  can't route around the block either. Callers pass raw paths — canonicalized once here at
   *  registration (realpathSync; falls back to path.resolve if the directory doesn't exist yet).
   *  Empty/absent (the default, and every existing test) means no denylist at all — daemon.ts is
   *  the sole production caller and always supplies normaHome's runDir (see daemon.ts). */
  deniedPrefixes?: string[];
}

// Bun's Glob.scan ignores `cwd` for absolute patterns and yields absolute
// paths directly — join()-ing those onto `root` would silently fabricate a
// bogus in-root path, so only join relative matches; pass absolute matches
// through as-is.
function combine(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

// The session tmp dir (where web_fetch saves full pages, bg-task output lives, etc.) is a
// Norma-managed, session-private, sandbox-writable location that is NOT in the write-fence `roots`.
// glob/grep's RELATIVE-pattern scanning additionally walks it (unchanged from before this task) so
// the agent can find what its own tools wrote there via a relative pattern. read/ls don't need it
// listed at all anymore: an absolute path is unrestricted (denylist aside) regardless of whether it
// happens to be tmpDir.
function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

function canonicalizeDenylist(prefixes: string[]): string[] {
  return prefixes.map((p) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  });
}

function isDenied(deniedPrefixes: string[], target: string): boolean {
  if (deniedPrefixes.length === 0) return false;
  const probe = canonAncestor(target);
  return deniedPrefixes.some((d) => probe === d || probe.startsWith(d + sep));
}

// Shared by glob/grep: resolves one Bun.Glob.scan match to its final absolute path, or null if it
// should never be surfaced. Two regimes, keyed off whether `p` (the RAW yielded match, before
// combine()) is itself absolute — i.e. whether the ORIGINATING pattern was absolute (Bun ignores
// `cwd` and walks the real filesystem for those) or relative (even a ".."-escaping one, which Bun
// still yields as a non-absolute string like "../sibling" — see combine()'s own comment):
//   - absolute-origin: may point ANYWHERE on disk (that's the point — a laptop-wide scan) — only
//     the denylist gates it, no containment check.
//   - relative-origin: keeps THE SAME scoped-to-scanRoots containment this had before this task
//     (via resolveWithinAny, which is also symlink-hardened) — a plain relative pattern must never
//     silently open up the whole disk just because it happened to climb out with "..".
function resolveMatch(scanRoots: string[], deniedPrefixes: string[], root: string, p: string): string | null {
  const candidate = combine(root, p);
  let resolved: string;
  if (isAbsolute(p)) {
    resolved = resolve(candidate);
  } else {
    try { resolved = resolveWithinAny(scanRoots, candidate); } catch { return null; }
  }
  return isDenied(deniedPrefixes, resolved) ? null : resolved;
}

export function registerReadTools(r: ToolRegistry, opts: ReadToolsConfig = {}): void {
  const deniedPrefixes = canonicalizeDenylist(opts.deniedPrefixes ?? []);

  r.register({
    name: "read",
    description: "Read a file's contents. Path may be relative to the session directory or an absolute path anywhere on disk. Optional offset (1-based start line) and limit (line count) read part of a large file — outputs over 64KB truncate, so page large files with offset/limit. Returns plain text without line numbers.",
    args: z.object({ path: z.string().min(1), offset: z.number().int().min(1).optional(), limit: z.number().int().positive().optional() }),
    run({ path, offset = 1, limit }, { roots }) {
      const target = isAbsolute(path) ? resolve(path) : resolve(roots[0]!, path);
      if (isDenied(deniedPrefixes, target)) throw new Error(DENY_MESSAGE);
      const content = readFileSync(target, "utf8");
      if (offset === 1 && limit === undefined) {
        return content;
      }
      const lines = content.split("\n");
      const endIdx = limit === undefined ? lines.length : offset - 1 + limit;
      const sliced = lines.slice(offset - 1, endIdx);
      return sliced.join("\n");
    },
  });

  r.register({
    name: "ls",
    description:
      "Lists files and directories in a given path (non-recursive, one level deep), anywhere on disk. `path` must be an absolute path, not a relative path. Optionally pass `ignore`, an array of glob patterns matched against entry names to exclude from the listing. Prefer `glob` or `grep` when you already know what you're looking for and want a targeted search rather than a full directory listing.",
    args: z.object({ path: z.string().min(1), ignore: z.array(z.string()).optional() }),
    run({ path, ignore }) {
      if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
      const target = resolve(path);
      if (isDenied(deniedPrefixes, target)) throw new Error(DENY_MESSAGE);
      let st;
      try {
        st = statSync(target);
      } catch {
        throw new Error(`path does not exist: ${path}`);
      }
      if (!st.isDirectory()) throw new Error(`path is not a directory: ${path}`);

      const patterns = (ignore ?? []).map((p: string) => new Bun.Glob(p));
      const dirs: string[] = [];
      const files: string[] = [];
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (patterns.some((g: InstanceType<typeof Bun.Glob>) => g.match(entry.name))) continue;
        // Denylisted entries simply don't appear (parity with glob/grep's silent skip) — without
        // this, listing the denied dir's PARENT would leak the bare entry name (task-10 review).
        if (isDenied(deniedPrefixes, join(target, entry.name))) continue;
        if (entry.isDirectory()) dirs.push(entry.name + "/");
        else files.push(entry.name);
      }
      dirs.sort();
      files.sort();
      const all = [...dirs, ...files];
      const shown = all.slice(0, LS_MAX_ENTRIES);
      let out = shown.join("\n");
      if (all.length > LS_MAX_ENTRIES) {
        out += (shown.length ? "\n" : "") + `… (+${all.length - LS_MAX_ENTRIES} more truncated)`;
      }
      return out;
    },
  });

  r.register({
    name: "glob",
    description: "List files matching a glob pattern (newline-separated, absolute paths). A relative pattern scans the session's directories; an absolute pattern (e.g. \"/Users/me/**/*.mp4\") may target anywhere on disk.",
    args: z.object({ pattern: z.string().min(1), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    async run({ pattern, budgetMs }, { roots, tmpDir }) {
      const out = new Set<string>();
      const deadline = Date.now() + budgetMs;
      const scanRoots = readRootsOf(roots, tmpDir);
      for (const root of scanRoots) {
        const glob = new Bun.Glob(pattern);
        try {
          for await (const p of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
            if (Date.now() > deadline) {
              return [...out].sort().join("\n") + (out.size ? "\n" : "") + "[scan time budget reached]";
            }
            const resolved = resolveMatch(scanRoots, deniedPrefixes, root, p);
            if (resolved) out.add(resolved); // denylisted/escaped-relative matches are skipped silently, never abort the scan
          }
        } catch {
          // Iterator threw mid-walk (e.g. EACCES from a genuinely-unreadable OS directory): never
          // surface a raw OS error/path — stop scanning this root, keep whatever was collected.
          continue;
        }
      }
      return [...out].sort().join("\n");
    },
  });

  r.register({
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line:text matches. `glob` scopes the search — a relative pattern stays within the session's directories; an absolute pattern may target anywhere on disk.",
    args: z.object({ pattern: z.string().min(1).max(256), glob: z.string().default("**/*"), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    async run({ pattern, glob: g, budgetMs }, { cwd, roots, tmpDir }) {
      // Pattern is model-controlled: length-capped as a cheap ReDoS bound.
      // Full guard (linear-time engine or scan timeout) tracked in phase-1 carryover.
      const re = new RegExp(pattern);
      const hits: string[] = [];
      const deadline = Date.now() + budgetMs;
      const scanRoots = readRootsOf(roots, tmpDir);
      for (const root of scanRoots) {
        const scanner = new Bun.Glob(g);
        try {
          for await (const p of scanner.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
            if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
            const abs = resolveMatch(scanRoots, deniedPrefixes, root, p);
            if (!abs) continue; // denylisted/escaped-relative match: skip silently, don't abort the scan
            let text: string;
            try { text = readFileSync(abs, "utf8"); } catch { continue; }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
              if (re.test(lines[i]!)) hits.push(`${relative(cwd, abs)}:${i + 1}:${lines[i]}`);
              if (hits.length >= 200) return hits.join("\n") + "\n[match cap reached]";
            }
          }
        } catch {
          // Iterator threw mid-walk (e.g. EACCES from a genuinely-unreadable OS directory) — same
          // tolerance as glob above. Stop scanning this root rather than leak the raw OS error.
          continue;
        }
      }
      return hits.join("\n");
    },
  });
}
