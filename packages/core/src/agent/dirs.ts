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

  has(sessionId: string, dir: string): boolean {
    return this.roots(sessionId).includes(this.canon(dir));
  }
}
