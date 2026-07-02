import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";

interface TrustFile { version: 1; trustedDirs: string[] }

/** Per-directory trust, persisted to a JSON file. Trust inherits to subdirectories. */
export class TrustStore {
  private trusted: string[];
  constructor(private readonly path: string) {
    this.trusted = TrustStore.read(path);
  }

  private static read(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustFile>;
      return Array.isArray(raw?.trustedDirs) ? raw.trustedDirs.map(String) : [];
    } catch { return []; }
  }

  private canon(dir: string): string {
    try { return realpathSync(dir); } catch { return dir; }
  }

  isTrusted(dir: string): boolean {
    const c = this.canon(dir);
    return this.trusted.some((t) => c === t || c.startsWith(t + sep));
  }

  trust(dir: string): void {
    const c = this.canon(dir);
    if (!this.trusted.includes(c)) {
      this.trusted.push(c);
      writeFileSync(this.path, JSON.stringify({ version: 1, trustedDirs: this.trusted }, null, 2) + "\n");
    }
  }

  list(): string[] { return [...this.trusted]; }
}
