import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname, basename, join } from "node:path";

/** Symlink-hardened: realpath of `target` itself if it exists, else of its deepest existing
 *  ancestor (walking up dirname). Exported for fs-read.ts's denylist check, which needs the exact
 *  same "what real directory does this path's existing part actually live in" answer that
 *  resolveWithinAny's own containment check below relies on — a symlink can't be used to hide a
 *  path from either. */
export function canonAncestor(target: string): string {
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
 *
 * Per-root resilient: a root whose `realpathSync` throws (vanished/renamed —
 * e.g. a worktree dir removed by `exit_worktree {remove}` that still lingers
 * in SessionDirectories' `added` set) is SKIPPED rather than fatal, so one
 * stale root can never brick resolution against the other, still-valid
 * roots. Mirrors the try/catch tolerance in dirs.ts's `canon`/`roots`.
 */
export function resolveWithinAny(roots: string[], p: string): string {
  if (roots.length === 0) throw new Error("no allowed directories configured");
  const reals: string[] = [];
  for (const r of roots) {
    try { reals.push(realpathSync(r)); }
    catch { /* vanished/renamed root — skip, don't let it break resolution against the others */ }
  }
  if (reals.length === 0) throw new Error(`path is outside the allowed directories: ${p}`);
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

/** Canonical location of a possibly-NOT-YET-EXISTING write target: realpath the deepest existing
 *  ancestor (same walk as canonAncestor above — resolves any symlinked directory on the way),
 *  then re-append the missing tail verbatim. Exists because neither existing primitive can answer
 *  "where would a write to `p` actually land": a bare `realpathSync(p)` THROWS on a missing file,
 *  and `isWithin`'s raw-text fallback then keeps the PRE-symlink spelling — which let a new file
 *  written through an in-cwd symlink into an added root classify as "within cwd" and skip the fs
 *  safety review (5e T3 review finding). Read-only: never creates anything on disk. */
export function canonicalizeForWrite(p: string): string {
  const target = resolve(p);
  let probe = target;
  const missing: string[] = [];
  while (true) {
    try {
      const real = realpathSync(probe);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return target; // nothing on the path exists at all — raw is all there is
      missing.push(basename(probe));
      probe = parent;
    }
  }
}
