import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadManifest, requiredConsentClasses } from "./plugin-manifest";

export const PluginManifest = z.object({
  name: z.string().optional(), description: z.string().optional(),
  version: z.string().optional(), author: z.string().optional(),
});

export interface PluginInfo {
  name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean;
  /** norma-plugin.json tier, when a valid manifest was found. undefined for legacy (plugin.json-only) plugins. */
  tier?: "capability" | "platform";
  /** Consent classes ("exec"|"tcc"|"hardware") the manifest requires, per plugin-manifest.ts#requiredConsentClasses. [] for legacy plugins. */
  requiredConsents: string[];
  /** Consent classes actually granted (from settings.plugins.consents). ALWAYS [] in this task — Task 2 fills this from settings records. */
  consented: string[];
  /** true when no valid norma-plugin.json was found (missing OR present-but-malformed) and the plugin loaded via the legacy plugin.json path. */
  legacy: boolean;
  /** true when norma-plugin.json declares contributes.mcpServers. Distinct from hasMcp, which reflects the legacy .mcp.json file. */
  hasManifestMcp: boolean;
}

/**
 * Reads ~/.norma/plugins/<name>/. The DIRECTORY NAME is the canonical plugin name.
 * norma-plugin.json (the Phase 4 superset manifest — see plugin-manifest.ts) is read first and,
 * when present and valid, is the source of truth for description/version/tier/consent classes.
 * Otherwise the plugin loads via the legacy path: plugin.json is metadata only (malformed →
 * ignored, the plugin still loads).
 */
export class PluginStore {
  constructor(private readonly deps: { normaHome: string; plugins?: { enabled?: string[]; disabled?: string[] }; log?: (m: string) => void }) {}

  list(): PluginInfo[] {
    const root = join(this.deps.normaHome, "plugins");
    let dirs: string[] = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    const enabled = this.deps.plugins?.enabled ?? [];
    const disabled = this.deps.plugins?.disabled ?? [];
    return dirs.map((name) => {
      const dir = join(root, name);
      let skills: string[] = [];
      try { skills = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md"))).map((e) => e.name); } catch { /* no skills dir */ }
      const isDisabled = disabled.includes(name);
      const shared = { name, skills, hasMcp: existsSync(join(dir, ".mcp.json")), mcpEnabled: enabled.includes(name) && !isDisabled, disabled: isDisabled };

      const { manifest } = loadManifest(dir, name, this.deps.log);
      if (manifest) {
        return {
          ...shared,
          description: manifest.description,
          version: manifest.version,
          tier: manifest.tier,
          requiredConsents: requiredConsentClasses(manifest),
          consented: [],
          legacy: false,
          hasManifestMcp: Boolean(manifest.contributes?.mcpServers?.length),
        };
      }

      let meta: z.infer<typeof PluginManifest> = {};
      try { meta = PluginManifest.parse(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))); }
      catch { this.deps.log?.(`plugin ${name}: no/invalid plugin.json (loading anyway)`); }
      return {
        ...shared,
        description: meta.description,
        version: meta.version,
        requiredConsents: [],
        consented: [],
        legacy: true,
        hasManifestMcp: false,
      };
    });
  }
}
