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
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    allow: z.array(z.string()).optional(),
  }).optional(),
  titles: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  plugins: z.object({
    enabled: z.array(z.string()).optional(),
    disabled: z.array(z.string()).optional(),
    /** Per-plugin per-permission-class consent records (design spec §1): { [pluginId]: { exec?:
     *  ts, tcc?: ts, hardware?: ts } }, timestamp = Date.now() at grant time. A class's presence
     *  (not its value) is what counts as consented — see plugins.ts#consentComplete. `disable`
     *  deletes a plugin's whole record (fresh-consent semantics, generalized from today's
     *  enabled-strip). */
    consents: z.record(z.string(), z.object({
      exec: z.number().optional(),
      tcc: z.number().optional(),
      hardware: z.number().optional(),
    })).optional(),
    /** PluginSupervisor lifecycle overrides (Phase 4b Task 3, spec §3 — all four values are
     *  spec-defaulted when omitted: registration timeout 10s, backoff cap 60s, circuit 5
     *  failures/10min). The invoke timeout (default 60s) and the SIGTERM→SIGKILL kill grace (5s)
     *  are deliberately NOT here — spec pins the former to the `NORMA_PLUGIN_TOOL_TIMEOUT_MS` env
     *  var and the latter isn't settings-overridable at all. */
    supervisor: z.object({
      registrationTimeoutMs: z.number().int().positive().optional(),
      backoffCapMs: z.number().int().positive().optional(),
      circuitFailures: z.number().int().positive().optional(),
      circuitWindowMs: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
  toolSearch: z.object({
    enabled: z.boolean().optional(),
    deferThreshold: z.number().int().positive().optional(),
  }).optional(),
  worktree: z.object({
    baseRef: z.enum(["fresh", "head"]).optional(),
  }).optional(),
  subagents: z.object({
    maxConcurrent: z.number().int().positive().optional(),
  }).optional(),
  /** Peripheral lease v1 (Phase 2f, spec §A1): "Heartbeat 5s / expiry 15s (user-confirmed;
   *  settings-overridable peripheral.heartbeatMs/expiryMs)". Both optional — PeripheralBroker
   *  falls back to the spec defaults (5000/15000) when omitted. */
  peripheral: z.object({
    heartbeatMs: z.number().int().positive().optional(),
    expiryMs: z.number().int().positive().optional(),
  }).optional(),
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

export function saveSettings(path: string, s: Settings): void {
  Settings.parse(s); // validate before writing — never persist an invalid settings file
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
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

/**
 * Merge additionalDirectories across scopes (Claude-Code-style). The COMMITTED
 * <projectDir>/.norma/settings.json is honored ONLY when `projectTrusted` — a repo
 * can't silently widen the fence until the user trusts the folder. The user's
 * ~/.norma/settings.json and the gitignored settings.local.json are always honored.
 */
export function loadPermissionDirs(homeDir: string, projectDir?: string, projectTrusted = false): string[] {
  const sources = [join(homeDir, "settings.json")]; // user global — always
  if (projectDir) {
    if (projectTrusted) sources.push(join(projectDir, ".norma", "settings.json")); // committed — trust-gated
    sources.push(join(projectDir, ".norma", "settings.local.json")); // local, gitignored — always
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
