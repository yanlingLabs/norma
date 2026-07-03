// Pure/isolatable logic behind `norma plugin ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Settings } from "@norma/core";

/** git-url basename minus a trailing `.git`, unless an explicit override is given. */
export function deriveInstallName(url: string, override?: string): string {
  if (override) return override;
  const last = url.replace(/\/+$/, "").split("/").pop();
  if (!last) throw new Error(`cannot derive a plugin name from ${url} — pass one explicitly`);
  return last.replace(/\.git$/, "");
}

/**
 * Resolve `<pluginsRoot>/<name>`, refusing anything that would resolve outside pluginsRoot
 * (e.g. name = "../x" or an absolute path). Throws rather than returning null so call sites
 * can't forget to check.
 */
export function resolvePluginTarget(pluginsRoot: string, name: string): string {
  const root = resolve(pluginsRoot);
  const target = resolve(root, name);
  if (!name || target === root || !target.startsWith(root + sep)) {
    throw new Error(`invalid plugin name: ${name}`);
  }
  return target;
}

export interface InstallPluginResult { name: string; target: string }

/**
 * Clone `url` into `<pluginsRoot>/<name>`. NEVER touches settings.json — installing a plugin
 * must not silently enable any MCP servers it bundles (fresh-consent rule lives in enable/disable).
 * Throws on: invalid/traversal name, an existing target dir, or a failed `git clone`.
 */
export function installPlugin(opts: { url: string; name?: string; pluginsRoot: string }): InstallPluginResult {
  const name = deriveInstallName(opts.url, opts.name);
  const target = resolvePluginTarget(opts.pluginsRoot, name);
  if (existsSync(target)) throw new Error(`${name} already exists at ${target}`);
  mkdirSync(opts.pluginsRoot, { recursive: true });
  const proc = Bun.spawnSync(["git", "clone", "--depth", "1", opts.url, target]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() || `git clone failed for ${opts.url}`);
  return { name, target };
}

/** Enable: add to enabled, remove from disabled. Disable: add to disabled, remove from enabled
 *  (fresh-consent rule — re-enabling after a disable is a deliberate act, not automatic). */
export function setPluginEnabled(settings: Settings, name: string, enabled: boolean): Settings {
  const en = new Set(settings.plugins?.enabled ?? []);
  const dis = new Set(settings.plugins?.disabled ?? []);
  if (enabled) { en.add(name); dis.delete(name); } else { dis.add(name); en.delete(name); }
  return { ...settings, plugins: { enabled: [...en], disabled: [...dis] } };
}

/** Strip `name` from both the enabled and disabled lists (used when removing a plugin). */
export function removePluginFromSettings(settings: Settings, name: string): Settings {
  if (!settings.plugins) return settings;
  return {
    ...settings,
    plugins: {
      enabled: (settings.plugins.enabled ?? []).filter((n) => n !== name),
      disabled: (settings.plugins.disabled ?? []).filter((n) => n !== name),
    },
  };
}

/** Validate + delete `<pluginsRoot>/<name>` (path-containment + existence checked). Returns the
 *  removed path. Does not touch settings — callers combine this with removePluginFromSettings. */
export function removePluginDir(pluginsRoot: string, name: string): string {
  const target = resolvePluginTarget(pluginsRoot, name);
  if (!existsSync(target)) throw new Error(`no such plugin: ${name}`);
  rmSync(target, { recursive: true, force: true });
  return target;
}
