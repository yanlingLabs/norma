import { z } from "zod";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolveWithinAny } from "../paths";
import type { ToolRegistry } from "./registry";

// Bun's Glob.scan ignores `cwd` for absolute patterns and yields absolute
// paths directly — join()-ing those onto `root` would silently fabricate a
// bogus in-root path and defeat the containment check, so only join relative
// matches; pass absolute matches through as-is for resolveWithinAny to vet.
function combine(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

export function registerReadTools(r: ToolRegistry): void {
  r.register({
    name: "read",
    description: "Read a file's contents. Path is relative to the session directory.",
    args: z.object({ path: z.string().min(1) }),
    run({ path }, { roots }) {
      return readFileSync(resolveWithinAny(roots, path), "utf8");
    },
  });

  r.register({
    name: "glob",
    description: "List files matching a glob pattern (relative paths, newline-separated).",
    args: z.object({ pattern: z.string().min(1) }),
    async run({ pattern }, { roots }) {
      const out = new Set<string>();
      for (const root of roots) {
        const glob = new Bun.Glob(pattern);
        // explicit: symlinks must not let matches escape the scoped roots
        // pattern is model-controlled: every match must stay inside a scoped root (same invariant as grep)
        for await (const p of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
          const candidate = combine(root, p);
          try { out.add(resolveWithinAny(roots, candidate)); } catch { /* outside all roots: never listed */ }
        }
      }
      return [...out].sort().join("\n");
    },
  });

  r.register({
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line:text matches.",
    args: z.object({ pattern: z.string().min(1).max(256), glob: z.string().default("**/*"), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    async run({ pattern, glob: g, budgetMs }, { cwd, roots }) {
      // Pattern is model-controlled: length-capped as a cheap ReDoS bound.
      // Full guard (linear-time engine or scan timeout) tracked in phase-1 carryover.
      const re = new RegExp(pattern);
      const hits: string[] = [];
      const deadline = Date.now() + budgetMs;
      for (const root of roots) {
        const scanner = new Bun.Glob(g);
        for await (const p of scanner.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
          if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
          let abs: string;
          try { abs = resolveWithinAny(roots, combine(root, p)); } catch { continue; }
          let text: string;
          try { text = readFileSync(abs, "utf8"); } catch { continue; }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
            if (re.test(lines[i]!)) hits.push(`${relative(cwd, abs)}:${i + 1}:${lines[i]}`);
            if (hits.length >= 200) return hits.join("\n") + "\n[match cap reached]";
          }
        }
      }
      return hits.join("\n");
    },
  });
}
