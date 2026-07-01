import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";

/**
 * Resolve `p` (relative or absolute) and verify it stays within `root`.
 * Symlink-hardened for existing paths; for not-yet-existing paths the nearest
 * existing ancestor is realpathed. Throws on escape.
 */
export function resolveWithin(root: string, p: string): string {
  const rootReal = realpathSync(root);
  const target = isAbsolute(p) ? resolve(p) : resolve(rootReal, p);
  // realpath the deepest existing ancestor to defeat symlink escapes
  let probe = target;
  while (true) {
    try { probe = realpathSync(probe); break; }
    catch { const parent = dirname(probe); if (parent === probe) break; probe = parent; }
  }
  if (probe !== rootReal && !probe.startsWith(rootReal + sep)) {
    throw new Error(`path is outside the session directory: ${p}`);
  }
  return target;
}
