import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapNormaDir } from "../src/norma-dir";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "norma-home-"));
}

describe("bootstrapNormaDir", () => {
  test("creates the full directory layout", () => {
    const home = tmpHome();
    const dirs = bootstrapNormaDir(home);
    for (const d of ["sessions", "memory", "skills/self", "agents", "plugins", "hooks", "logs", "run"]) {
      expect(existsSync(join(home, d))).toBe(true);
    }
    expect(dirs.runDir).toBe(join(home, "run"));
    expect(dirs.socketPath).toBe(join(home, "run", "core.sock"));
  });

  test("run dir is 0700", () => {
    const home = tmpHome();
    bootstrapNormaDir(home);
    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
  });

  test("writes default settings.json once, never overwrites", () => {
    const home = tmpHome();
    bootstrapNormaDir(home);
    const settingsPath = join(home, "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("schemaVersion", 1);
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, custom: true }));
    bootstrapNormaDir(home); // idempotent
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("custom", true);
  });
});
