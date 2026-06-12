import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@norma/protocol";
import type { SecretStore } from "./secret-store";

export const TOKEN_NAMES = { harness: "harness-token", admin: "admin-token" } as const;

export class TokenAuthority {
  constructor(private readonly store: SecretStore) {}

  async ensureTokens(): Promise<{ harness: string; admin: string }> {
    const out: Record<string, string> = {};
    for (const [role, name] of Object.entries(TOKEN_NAMES)) {
      let v = await this.store.get(name);
      if (!v) {
        v = randomBytes(32).toString("hex");
        await this.store.set(name, v);
      }
      out[role] = v;
    }
    return out as { harness: string; admin: string };
  }

  async verify(role: Role, token: string): Promise<boolean> {
    const name = (TOKEN_NAMES as Record<string, string | undefined>)[role];
    if (!name) return false; // plugin tokens arrive in Phase 4
    const expected = await this.store.get(name);
    if (!expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    // length guard needed before timingSafeEqual; safe because all tokens are fixed-length (64 hex chars)
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
