import { z } from "zod";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { resolveWithin } from "../paths";
import type { ToolRegistry } from "./registry";

export function registerReadTools(r: ToolRegistry): void {
  r.register({
    name: "read",
    description: "Read a file's contents. Path is relative to the session directory.",
    args: z.object({ path: z.string().min(1) }),
    run({ path }, { cwd }) {
      return readFileSync(resolveWithin(cwd, path), "utf8");
    },
  });

  r.register({
    name: "glob",
    description: "List files matching a glob pattern (relative paths, newline-separated).",
    args: z.object({ pattern: z.string().min(1) }),
    async run({ pattern }, { cwd }) {
      const glob = new Bun.Glob(pattern);
      const out: string[] = [];
      // explicit: symlinks must not let matches escape the scoped root
      // pattern is model-controlled: every match must stay inside the scoped root (same invariant as grep)
      for await (const p of glob.scan({ cwd, onlyFiles: true, followSymlinks: false })) {
        try { resolveWithin(cwd, p); out.push(p); } catch { /* outside root: never listed */ }
      }
      return out.sort().join("\n");
    },
  });

  r.register({
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line:text matches.",
    args: z.object({ pattern: z.string().min(1).max(256), glob: z.string().default("**/*") }),
    async run({ pattern, glob: g }, { cwd }) {
      // Pattern is model-controlled: length-capped as a cheap ReDoS bound.
      // Full guard (linear-time engine or scan timeout) tracked in phase-1 carryover.
      const re = new RegExp(pattern);
      const scanner = new Bun.Glob(g);
      const hits: string[] = [];
      for await (const p of scanner.scan({ cwd, onlyFiles: true, followSymlinks: false })) {
        let text: string;
        const abs = resolveWithin(cwd, p);
        try { text = readFileSync(abs, "utf8"); } catch { continue; }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) hits.push(`${relative(cwd, abs)}:${i + 1}:${lines[i]}`);
          if (hits.length >= 200) return hits.join("\n") + "\n[match cap reached]";
        }
      }
      return hits.join("\n");
    },
  });
}
