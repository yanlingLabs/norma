import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createProvider, OPENAI_API_KEY_SECRET } from "../../src/providers/manager";

describe("createProvider", () => {
  test("codex-oauth settings yield the codex provider (quota-wrapped)", async () => {
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.2-codex" } },
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p.provider.id).toBe("codex-oauth");
    expect(p.model).toBe("gpt-5.2-codex");
    expect(p.quota.state().kind).toBe("ok");
  });

  test("openai-compatible requires an api key in the secret store", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await expect(createProvider(
      { schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x" } },
      store,
    )).rejects.toThrow(/api key/i);
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const p = await createProvider(
      { schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x" } },
      store,
    );
    expect(p.provider.id).toBe("openai-compatible");
  });
});
