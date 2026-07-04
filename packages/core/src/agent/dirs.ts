import { realpathSync } from "node:fs";

/** Live allowed-roots per session: static base roots + runtime-added dirs. */
export class SessionDirectories {
  private added = new Map<string, Set<string>>();
  constructor(private readonly baseDirs: (sessionId: string) => string[]) {}

  private canon(p: string): string { try { return realpathSync(p); } catch { return p; } }

  roots(sessionId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (p: string) => { const c = this.canon(p); if (!seen.has(c)) { seen.add(c); out.push(c); } };
    for (const d of this.baseDirs(sessionId)) push(d);
    for (const d of this.added.get(sessionId) ?? []) push(d);
    return out;
  }

  add(sessionId: string, dir: string): void {
    let set = this.added.get(sessionId);
    if (!set) { set = new Set(); this.added.set(sessionId, set); }
    set.add(this.canon(dir));
  }

  /** Undo a prior `add` (e.g. a worktree that was entered then exited/removed). Deletes both the
   *  canonical form (works if `dir` still exists on disk) and the raw literal (works once `dir`
   *  has been deleted, since `canon` then falls back to the literal path) — whichever matches what
   *  `add` actually stored. A no-op if `dir` was never added. Without this, a since-vanished root
   *  lingers in the `added` set forever; `resolveWithinAny`'s per-root resilience (paths.ts) is a
   *  defensive backstop for that case, but this keeps the roots list itself accurate. */
  remove(sessionId: string, dir: string): void {
    const set = this.added.get(sessionId);
    if (!set) return;
    set.delete(this.canon(dir));
    set.delete(dir);
  }

  has(sessionId: string, dir: string): boolean {
    return this.roots(sessionId).includes(this.canon(dir));
  }
}
