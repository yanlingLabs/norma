import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings";

function tmpSettings(content: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), "norma-set-")), "settings.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadSettings", () => {
  test("migrates schemaVersion 1 → 2 with codex-oauth default and persists", () => {
    const p = tmpSettings({ schemaVersion: 1 });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.provider).toEqual({ type: "codex-oauth", model: "gpt-5.2-codex" });
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(2); // migration persisted
  });

  test("valid v2 settings load as-is", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://api.openai.com/v1" } });
    expect(loadSettings(p).provider.type).toBe("openai-compatible");
  });

  test("corrupt settings throw a readable error", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "telepathy" } });
    expect(() => loadSettings(p)).toThrow(/settings/);
  });
});
