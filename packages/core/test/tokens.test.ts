import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";

function makeAuthority(): TokenAuthority {
  return new TokenAuthority(new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-secrets-"))));
}

describe("TokenAuthority", () => {
  test("ensureTokens mints harness+admin tokens once and is idempotent", async () => {
    const auth = makeAuthority();
    const first = await auth.ensureTokens();
    const second = await auth.ensureTokens();
    expect(first.harness).toBe(second.harness);
    expect(first.admin).toBe(second.admin);
    expect(first.harness).not.toBe(first.admin);
    expect(first.harness.length).toBeGreaterThanOrEqual(64); // 32 random bytes hex
  });

  test("verify accepts the right token for the right role only", async () => {
    const auth = makeAuthority();
    const t = await auth.ensureTokens();
    expect(await auth.verify("harness", t.harness)).toBe(true);
    expect(await auth.verify("admin", t.admin)).toBe(true);
    expect(await auth.verify("admin", t.harness)).toBe(false);
    expect(await auth.verify("harness", "wrong")).toBe(false);
    expect(await auth.verify("plugin", t.harness)).toBe(false); // no plugin tokens in Phase 0
  });
});
