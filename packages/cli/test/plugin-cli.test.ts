import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Settings } from "@norma/core";
import {
  deriveInstallName,
  installPlugin,
  removePluginDir,
  removePluginFromSettings,
  resolvePluginTarget,
  setPluginEnabled,
} from "../src/plugin-cli";

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, ...overrides } as Settings;
}

/** A local git repo with a minimal plugin layout, suitable for `git clone` off a plain path. */
function makePluginFixtureRepo(): string {
  const src = mkdtempSync(join(tmpdir(), "norma-plugin-src-"));
  mkdirSync(join(src, "skills", "greet"), { recursive: true });
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
  writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "ignored-manifest-name", version: "1.0.0" }));
  writeFileSync(join(src, ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  Bun.spawnSync(["git", "init", "-q"], { cwd: src, env });
  Bun.spawnSync(["git", "add", "-A"], { cwd: src, env });
  const commit = Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: src, env });
  if (commit.exitCode !== 0) throw new Error(`fixture commit failed: ${commit.stderr.toString()}`);
  return src;
}

describe("deriveInstallName", () => {
  test("derives from the git URL basename, stripping .git and trailing slashes", () => {
    expect(deriveInstallName("https://example.com/org/my-plugin.git")).toBe("my-plugin");
    expect(deriveInstallName("https://example.com/org/my-plugin.git/")).toBe("my-plugin");
    expect(deriveInstallName("/local/path/to/plugin")).toBe("plugin");
  });
  test("an explicit override wins over the derived name", () => {
    expect(deriveInstallName("https://example.com/org/my-plugin.git", "custom")).toBe("custom");
  });
});

describe("resolvePluginTarget (path containment)", () => {
  const root = "/tmp/norma-plugins-root";
  test("a plain name resolves under the root", () => {
    expect(resolvePluginTarget(root, "demo")).toBe(join(root, "demo"));
  });
  test("traversal names are refused", () => {
    expect(() => resolvePluginTarget(root, "../x")).toThrow(/invalid plugin name/);
    expect(() => resolvePluginTarget(root, "../../etc")).toThrow(/invalid plugin name/);
  });
  test("an absolute path escaping the root is refused", () => {
    expect(() => resolvePluginTarget(root, "/etc/passwd")).toThrow(/invalid plugin name/);
  });
  test("the empty name or the root itself is refused", () => {
    expect(() => resolvePluginTarget(root, "")).toThrow(/invalid plugin name/);
    expect(() => resolvePluginTarget(root, ".")).toThrow(/invalid plugin name/);
  });
});

describe("installPlugin", () => {
  test("clones a local fixture repo into <pluginsRoot>/<name>; a second install of the same name is refused", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));

    const result = installPlugin({ url: repo, pluginsRoot });
    expect(result.name).toBe(basename(repo)); // derived from the repo's dirname (no override given)
    expect(existsSync(join(result.target, "skills", "greet", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.target, ".mcp.json"))).toBe(true);

    expect(() => installPlugin({ url: repo, name: result.name, pluginsRoot })).toThrow(/already exists/);
  });

  test("an explicit name is honored and NEVER touches settings.json", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));
    const settingsPath = join(pluginsRoot, "..", "settings.json"); // sibling of pluginsRoot, mirrors ~/.norma layout

    const result = installPlugin({ url: repo, name: "demo", pluginsRoot });
    expect(result.name).toBe("demo");
    expect(existsSync(join(pluginsRoot, "demo"))).toBe(true);
    expect(existsSync(settingsPath)).toBe(false); // install created no settings file at all
  });

  test("a traversal name is refused before any clone is attempted", () => {
    const repo = makePluginFixtureRepo();
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));
    expect(() => installPlugin({ url: repo, name: "../escaped", pluginsRoot })).toThrow(/invalid plugin name/);
    expect(existsSync(join(pluginsRoot, "..", "escaped"))).toBe(false);
  });
});

describe("setPluginEnabled (fresh-consent rule)", () => {
  test("enable adds to enabled and ensures it's not in disabled", () => {
    const s = setPluginEnabled(baseSettings({ plugins: { enabled: [], disabled: ["demo"] } }), "demo", true);
    expect(s.plugins?.enabled).toEqual(["demo"]);
    expect(s.plugins?.disabled).toEqual([]);
  });
  test("disable adds to disabled and removes from enabled — re-enabling later requires a fresh `enable`", () => {
    let s = setPluginEnabled(baseSettings(), "demo", true);
    expect(s.plugins?.enabled).toEqual(["demo"]);
    s = setPluginEnabled(s, "demo", false);
    expect(s.plugins?.enabled).toEqual([]);
    expect(s.plugins?.disabled).toEqual(["demo"]);
  });
  test("starting from settings with no `plugins` key at all still works", () => {
    const s = setPluginEnabled(baseSettings(), "demo", true);
    expect(s.plugins).toEqual({ enabled: ["demo"], disabled: [] });
  });
});

describe("removePluginFromSettings", () => {
  test("strips the name from both enabled and disabled lists", () => {
    const s = removePluginFromSettings(baseSettings({ plugins: { enabled: ["a", "demo"], disabled: ["demo", "b"] } }), "demo");
    expect(s.plugins).toEqual({ enabled: ["a"], disabled: ["b"] });
  });
  test("a no-op when settings has no plugins key", () => {
    const s = baseSettings();
    expect(removePluginFromSettings(s, "demo")).toBe(s);
  });
});

describe("removePluginDir", () => {
  test("deletes an existing plugin directory and returns its path", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));
    const dir = join(pluginsRoot, "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{}");
    const removed = removePluginDir(pluginsRoot, "demo");
    expect(removed).toBe(join(pluginsRoot, "demo"));
    expect(existsSync(dir)).toBe(false);
  });
  test("a traversal name is refused", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));
    expect(() => removePluginDir(pluginsRoot, "../x")).toThrow(/invalid plugin name/);
  });
  test("a nonexistent (but validly-scoped) name is refused", () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "norma-plugins-root-"));
    expect(() => removePluginDir(pluginsRoot, "ghost")).toThrow(/no such plugin/);
  });
});
