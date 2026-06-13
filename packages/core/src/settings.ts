import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const ProviderSettings = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex-oauth"), model: z.string().min(1) }),
  z.object({ type: z.literal("openai-compatible"), model: z.string().min(1), baseUrl: z.string().url() }),
]);

export const Settings = z.object({
  schemaVersion: z.literal(2),
  provider: ProviderSettings,
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
