import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

const SERVICE = "com.norma.core";

/** Production store: macOS Keychain via Bun.secrets. */
export class KeychainSecretStore implements SecretStore {
  async get(name: string): Promise<string | null> {
    return (await Bun.secrets.get({ service: SERVICE, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: SERVICE, name, value });
  }
}

/** Test/CI store: 0600 files in a directory. Never used in production paths. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  async get(name: string): Promise<string | null> {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  async set(name: string, value: string): Promise<void> {
    const p = join(this.dir, name);
    writeFileSync(p, value);
    chmodSync(p, 0o600);
  }
}
