import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ProviderSettings = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex-oauth"), model: z.string().min(1) }),
  z.object({ type: z.literal("openai-compatible"), model: z.string().min(1), baseUrl: z.string().url() }),
]);

export const PermissionsSettings = z.object({
  additionalDirectories: z.array(z.string()).optional(),
});

export const Settings = z.object({
  schemaVersion: z.literal(2),
  provider: ProviderSettings,
  permissions: PermissionsSettings.optional(),
});
export type Settings = z.infer<typeof Settings>;

const DEFAULT_PROVIDER = { type: "codex-oauth", model: "gpt-5.4" } as const;

export function loadSettings(path: string): Settings {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`settings file not found at ${path} — run \`norma daemon run\` once to initialize`);
    }
    throw err;
  }
  if (raw.schemaVersion !== 2) {
    // v1-or-legacy file (Phase 0 wrote {schemaVersion:1}; the retired v1 app wrote files with
    // no schemaVersion at all — same directory on case-insensitive APFS). Migrate to v2,
    // preserving unknown fields so nothing is silently lost.
    const { schemaVersion: _legacy, ...preserved } = raw;
    const migrated = { ...preserved, schemaVersion: 2 as const, provider: DEFAULT_PROVIDER };
    writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
    // zod v4 z.object() strips unknown keys by default (does NOT throw) — safe to parse migrated
    return Settings.parse(migrated);
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`settings.json is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} — fix or delete ${path}`);
  }
  return parsed.data;
}

function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

function readDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const dirs = raw?.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.map(String) : [];
  } catch {
    return [];
  }
}

/** Merge additionalDirectories across user → project → local scopes (Claude-Code-style). */
export function loadPermissionDirs(homeDir: string, projectDir?: string): string[] {
  const sources = [join(homeDir, "settings.json")];
  if (projectDir) {
    sources.push(join(projectDir, ".norma", "settings.json"));
    sources.push(join(projectDir, ".norma", "settings.local.json"));
  }
  const merged: string[] = [];
  for (const src of sources) {
    for (const d of readDirs(src)) {
      const e = expandTilde(d);
      if (!merged.includes(e)) merged.push(e);
    }
  }
  return merged;
}

/** Persist a runtime-granted directory to the project's local (gitignored) settings. */
export function addLocalDir(projectDir: string, dir: string): void {
  const dotNorma = join(projectDir, ".norma");
  mkdirSync(dotNorma, { recursive: true });
  const path = join(dotNorma, "settings.local.json");
  let obj: any = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj.permissions ??= {};
  obj.permissions.additionalDirectories ??= [];
  if (!obj.permissions.additionalDirectories.includes(dir)) obj.permissions.additionalDirectories.push(dir);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
