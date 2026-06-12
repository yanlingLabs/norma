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

const DEFAULT_PROVIDER = { type: "codex-oauth", model: "gpt-5.2-codex" } as const;

export function loadSettings(path: string): Settings {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.schemaVersion === 1) {
    const migrated: Settings = { schemaVersion: 2, provider: DEFAULT_PROVIDER };
    writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
    return migrated;
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`settings.json is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} — fix or delete ${path}`);
  }
  return parsed.data;
}
