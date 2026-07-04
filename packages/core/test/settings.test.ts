import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, loadPermissionDirs, addLocalDir, saveSettings, Settings } from "../src/settings";
import { mkdirSync, writeFileSync as wf } from "node:fs";

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
    expect(s.provider).toEqual({ type: "codex-oauth", model: "gpt-5.4" });
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

  test("missing settings file throws a readable error", () => {
    expect(() => loadSettings(join(mkdtempSync(join(tmpdir(), "norma-set-")), "settings.json"))).toThrow(/norma daemon run/);
  });

  test("legacy v1-app settings (no schemaVersion) migrate, preserving v1 keys", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.provider.type).toBe("codex-oauth");
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.webSearch).toEqual({ provider: "disabled" }); // v1 data preserved on disk
    expect(onDisk.schemaVersion).toBe(2);
  });

  test("v1→v2 migration preserves unknown fields on disk", () => {
    const p = tmpSettings({ schemaVersion: 1, custom: true });
    loadSettings(p);
    expect(JSON.parse(readFileSync(p, "utf8")).custom).toBe(true);
  });

  test("v1→v2 migration preserves a permissions block in the parsed result", () => {
    const p = tmpSettings({ schemaVersion: 1, permissions: { additionalDirectories: ["~/kept", "/opt/kept"] } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.permissions?.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
    // and on disk:
    const onDisk = JSON.parse(require("node:fs").readFileSync(p, "utf8"));
    expect(onDisk.permissions.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
  });

  test("legacy no-schemaVersion file with permissions migrates and keeps them", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" }, permissions: { additionalDirectories: ["/opt/x"] } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.permissions?.additionalDirectories).toEqual(["/opt/x"]);
  });

  test("mcpServers parses; absent → undefined; legacy migration keeps working", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: { X: "1" } } } });
    if (!s.mcpServers) throw new Error("mcpServers must be defined");
    expect(s.mcpServers["everything"]?.command).toBe("npx");
    const none = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } });
    expect(none.mcpServers).toBeUndefined();
  });

  test("reviewer config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, reviewer: { enabled: true, model: "gpt-5.4-mini", allow: ["git status"] } });
    expect(s.reviewer).toEqual({ enabled: true, model: "gpt-5.4-mini", allow: ["git status"] });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).reviewer).toBeUndefined();
  });

  test("legacy migration keeps working with reviewer field absent", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.reviewer).toBeUndefined();
  });

  test("plugins config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, plugins: { enabled: ["a"], disabled: ["b"] } });
    expect(s.plugins).toEqual({ enabled: ["a"], disabled: ["b"] });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).plugins).toBeUndefined();
  });

  test("legacy migration keeps working with plugins field absent", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.plugins).toBeUndefined();
  });

  test("toolSearch config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: { enabled: true, deferThreshold: 20 } });
    expect(s.toolSearch).toEqual({ enabled: true, deferThreshold: 20 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).toolSearch).toBeUndefined();
  });

  test("legacy migration keeps working with toolSearch field absent", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.toolSearch).toBeUndefined();
  });

  test("worktree config parses; absent → undefined; bad baseRef rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, worktree: { baseRef: "fresh" } });
    expect(s.worktree).toEqual({ baseRef: "fresh" });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).worktree).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, worktree: { baseRef: "bogus" } })).toThrow();
  });

  test("legacy migration keeps working with worktree field absent", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.worktree).toBeUndefined();
  });

  test("subagents config parses; absent → undefined; non-positive maxConcurrent rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: 2 } });
    expect(s.subagents).toEqual({ maxConcurrent: 2 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).subagents).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: -1 } })).toThrow();
  });

  test("legacy migration keeps working with subagents field absent", () => {
    const p = tmpSettings({ webSearch: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.subagents).toBeUndefined();
  });
});

describe("saveSettings", () => {
  test("writes a file that loadSettings round-trips", () => {
    const p = join(mkdtempSync(join(tmpdir(), "norma-save-")), "settings.json");
    const s: Settings = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, plugins: { enabled: ["a"] } };
    saveSettings(p, s);
    expect(loadSettings(p)).toEqual(s);
  });

  test("throws on an invalid object (bad schemaVersion) and does not write", () => {
    const p = join(mkdtempSync(join(tmpdir(), "norma-save-")), "settings.json");
    expect(() => saveSettings(p, { schemaVersion: 1, provider: { type: "codex-oauth", model: "gpt-5.4" } } as unknown as Settings)).toThrow();
  });
});

describe("permission directories", () => {
  test("Settings accepts an optional permissions.additionalDirectories block", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["~/x"] } });
    expect(loadSettings(p).permissions?.additionalDirectories).toEqual(["~/x"]);
  });

  test("loadPermissionDirs merges user + project + local, expands ~, dedups (trusted project)", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-perm-home-"));
    const project = mkdtempSync(join(tmpdir(), "norma-perm-proj-"));
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["~/shared"] } }));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/data", "~/shared"] } }));
    wf(join(project, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/tmp/local-grant"] } }));
    // committed .norma/settings.json only merges when the project is trusted — see
    // "loadPermissionDirs trust gating" below for the untrusted-gates-it-out coverage.
    const dirs = loadPermissionDirs(home, project, true);
    const { homedir } = require("node:os");
    expect(dirs).toContain(join(homedir(), "shared"));
    expect(dirs).toContain("/opt/data");
    expect(dirs).toContain("/tmp/local-grant");
    expect(dirs.filter((d) => d === join(homedir(), "shared"))).toHaveLength(1); // deduped
  });

  test("loadPermissionDirs tolerates missing files and missing blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-perm-h2-"));
    expect(loadPermissionDirs(home)).toEqual([]); // nothing configured
  });

  test("addLocalDir appends to settings.local.json without duplicates", () => {
    const project = mkdtempSync(join(tmpdir(), "norma-perm-add-"));
    addLocalDir(project, "/opt/one");
    addLocalDir(project, "/opt/one"); // dup ignored
    addLocalDir(project, "/opt/two");
    const local = JSON.parse(require("node:fs").readFileSync(join(project, ".norma", "settings.local.json"), "utf8"));
    expect(local.permissions.additionalDirectories).toEqual(["/opt/one", "/opt/two"]);
  });
});

describe("loadPermissionDirs trust gating", () => {
  function scaffold() {
    const home = mkdtempSync(join(tmpdir(), "norma-tg-home-"));
    const project = mkdtempSync(join(tmpdir(), "norma-tg-proj-"));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["/opt/user-dir"] } }));
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/committed-dir"] } }));       // committed → trust-gated
    wf(join(project, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/local-dir"] } }));    // gitignored → always
    return { home, project };
  }

  test("UNtrusted project: committed settings.json is IGNORED; user + local still apply", () => {
    const { home, project } = scaffold();
    const dirs = loadPermissionDirs(home, project, false);
    expect(dirs).toContain("/opt/user-dir");    // user global — always
    expect(dirs).toContain("/opt/local-dir");   // local gitignored — always
    expect(dirs).not.toContain("/opt/committed-dir"); // committed — gated out when untrusted
  });

  test("TRUSTED project: committed settings.json now applies", () => {
    const { home, project } = scaffold();
    const dirs = loadPermissionDirs(home, project, true);
    expect(dirs).toContain("/opt/committed-dir");
    expect(dirs).toContain("/opt/user-dir");
    expect(dirs).toContain("/opt/local-dir");
  });

  test("SECURITY: an untrusted committed settings.json cannot self-grant a broad root", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-tg-h2-"));
    const project = mkdtempSync(join(tmpdir(), "norma-tg-p2-"));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/", "~"] } }));
    const { homedir } = require("node:os");
    const untrusted = loadPermissionDirs(home, project, false);
    expect(untrusted).not.toContain("/");
    expect(untrusted).not.toContain(homedir());
    const trusted = loadPermissionDirs(home, project, true);
    expect(trusted).toContain("/"); // only once the user trusts the folder
  });

  test("default projectTrusted is false (fail-closed)", () => {
    const { home, project } = scaffold();
    expect(loadPermissionDirs(home, project)).not.toContain("/opt/committed-dir");
  });
});
