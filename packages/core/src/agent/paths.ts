import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname } from "node:path";

function canonAncestor(target: string): string {
  let probe = target;
  while (true) {
    try { return realpathSync(probe); }
    catch { const parent = dirname(probe); if (parent === probe) return probe; probe = parent; }
  }
}

/**
 * Resolve `p` (relative → roots[0]) and verify it stays within ANY root.
 * Symlink-hardened: the deepest existing ancestor is realpathed before the
 * containment check. Throws on escape.
 */
export function resolveWithinAny(roots: string[], p: string): string {
  if (roots.length === 0) throw new Error("no allowed directories configured");
  const reals = roots.map((r) => realpathSync(r));
  const target = isAbsolute(p) ? resolve(p) : resolve(reals[0]!, p);
  const probe = canonAncestor(target);
  for (const root of reals) {
    if (probe === root || probe.startsWith(root + sep)) return target;
  }
  throw new Error(`path is outside the allowed directories: ${p}`);
}

/** Single-root convenience wrapper (unchanged behavior for existing callers). */
export function resolveWithin(root: string, p: string): string {
  return resolveWithinAny([root], p);
}

/** True if `child` is `parent` or a descendant of it (both realpath-canonicalized; falls back to raw on error). */
export function isWithin(child: string, parent: string): boolean {
  const canon = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const c = canon(child), t = canon(parent);
  return c === t || c.startsWith(t + sep);
}
