import { z } from "zod";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolveWithinAny } from "../paths";
import type { ToolRegistry } from "./registry";

const LS_MAX_ENTRIES = 1000;

// Bun's Glob.scan ignores `cwd` for absolute patterns and yields absolute
// paths directly — join()-ing those onto `root` would silently fabricate a
// bogus in-root path and defeat the containment check, so only join relative
// matches; pass absolute matches through as-is for resolveWithinAny to vet.
function combine(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

// The session tmp dir (where web_fetch saves full pages, bg-task output lives, etc.) is a
// Norma-managed, session-private, sandbox-writable location that is NOT in the write-fence `roots`.
// The READ-ONLY fs tools append it as an allowed READ/scan root so the agent can read/grep/glob
// what its own tools wrote there (e.g. web_fetch's saved page). roots[0] stays the primary cwd, so
// relative-path resolution and grep's `relative(cwd, …)` are unchanged; no write fence is widened
// (these tools never write).
function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

export function registerReadTools(r: ToolRegistry): void {
  r.register({
    name: "read",
    description: "Read a file's contents. Path is relative to the session directory. Optional offset (1-based start line) and limit (line count) read part of a large file — outputs over 64KB truncate, so page large files with offset/limit. Returns plain text without line numbers.",
    args: z.object({ path: z.string().min(1), offset: z.number().int().min(1).optional(), limit: z.number().int().positive().optional() }),
    run({ path, offset = 1, limit }, { roots, tmpDir }) {
      const content = readFileSync(resolveWithinAny(readRootsOf(roots, tmpDir), path), "utf8");
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
      "Lists files and directories in a given path (non-recursive, one level deep). `path` must be an absolute path, not a relative path. Optionally pass `ignore`, an array of glob patterns matched against entry names to exclude from the listing. Prefer `glob` or `grep` when you already know what you're looking for and want a targeted search rather than a full directory listing.",
    args: z.object({ path: z.string().min(1), ignore: z.array(z.string()).optional() }),
    run({ path, ignore }, { roots, tmpDir }) {
      if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
      const target = resolveWithinAny(readRootsOf(roots, tmpDir), path);
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
    description: "List files matching a glob pattern (relative paths, newline-separated).",
    args: z.object({ pattern: z.string().min(1), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    async run({ pattern, budgetMs }, { roots, tmpDir }) {
      const out = new Set<string>();
      const deadline = Date.now() + budgetMs;
      const scanRoots = readRootsOf(roots, tmpDir);
      for (const root of scanRoots) {
        const glob = new Bun.Glob(pattern);
        try {
          // explicit: symlinks must not let matches escape the scoped roots
          // pattern is model-controlled: every match must stay inside a scoped root (same invariant as grep)
          for await (const p of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
            if (Date.now() > deadline) {
              return [...out].sort().join("\n") + (out.size ? "\n" : "") + "[scan time budget reached]";
            }
            const candidate = combine(root, p);
            try { out.add(resolveWithinAny(scanRoots, candidate)); } catch { /* outside all roots: never listed */ }
          }
        } catch {
          // Iterator threw mid-walk (e.g. EACCES): an absolute recursive pattern
          // (e.g. "/etc/**") makes Bun.Glob ignore `cwd` and walk the real
          // filesystem outside the scoped roots, where unreadable subtrees throw
          // raw OS errors carrying real paths. Never surface that — stop
          // scanning this root and move on with whatever was already collected.
          continue;
        }
      }
      return [...out].sort().join("\n");
    },
  });

  r.register({
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line:text matches.",
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
            let abs: string;
            try { abs = resolveWithinAny(scanRoots, combine(root, p)); } catch { continue; }
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
          // Iterator threw mid-walk (e.g. EACCES from an absolute recursive
          // glob walking outside the scoped roots) — same containment gap as
          // above. Stop scanning this root rather than leak the raw OS path.
          continue;
        }
      }
      return hits.join("\n");
    },
  });
}
