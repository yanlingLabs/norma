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
  /** Consent classes actually granted, filled from settings.plugins.consents[name] (a class counts
   *  as consented when its key is present in the record, regardless of the timestamp value). []
   *  when there's no consents dep or no record for this plugin. See consentComplete/pluginMcpEligible below. */
  consented: string[];
  /** true when no valid norma-plugin.json was found (missing OR present-but-malformed) and the plugin loaded via the legacy plugin.json path. */
  legacy: boolean;
  /** true when norma-plugin.json declares contributes.mcpServers. Distinct from hasMcp, which reflects the legacy .mcp.json file. */
  hasManifestMcp: boolean;
}

/** Consent record shape for one plugin: settings.plugins.consents[id] (settings.ts). */
export type PluginConsentRecord = { exec?: number; tcc?: number; hardware?: number };

const CONSENT_CLASSES = ["exec", "tcc", "hardware"] as const;

/**
 * Reads ~/.norma/plugins/<name>/. The DIRECTORY NAME is the canonical plugin name.
 * norma-plugin.json (the Phase 4 superset manifest — see plugin-manifest.ts) is read first and,
 * when present and valid, is the source of truth for description/version/tier/consent classes.
 * Otherwise the plugin loads via the legacy path: plugin.json is metadata only (malformed →
 * ignored, the plugin still loads).
 */
export class PluginStore {
  constructor(
    private readonly deps: {
      normaHome: string;
      plugins?: { enabled?: string[]; disabled?: string[] };
      /** settings.plugins.consents — per-plugin-id consent records. Kept as a sibling dep (not
       *  nested under `plugins`) so callers/tests can wire it independently of enabled/disabled. */
      consents?: Record<string, PluginConsentRecord>;
      log?: (m: string) => void;
    },
  ) {}

  private consentedClasses(name: string): string[] {
    const record = this.deps.consents?.[name];
    if (!record) return [];
    return CONSENT_CLASSES.filter((c) => record[c] !== undefined);
  }

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
      const consented = this.consentedClasses(name);

      const { manifest } = loadManifest(dir, name, this.deps.log);
      if (manifest) {
        return {
          ...shared,
          description: manifest.description,
          version: manifest.version,
          tier: manifest.tier,
          requiredConsents: requiredConsentClasses(manifest),
          consented,
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
        consented,
        legacy: true,
        hasManifestMcp: false,
      };
    });
  }
}

/**
 * True when every consent class a plugin's manifest requires (`requiredConsents`) has a matching
 * record in `consented`. Legacy plugins have `requiredConsents === []`, so this is vacuously true
 * for them — consent never gates legacy plugin content (spec: "everything above keeps working
 * unchanged").
 */
export function consentComplete(p: PluginInfo): boolean {
  return p.requiredConsents.every((c) => p.consented.includes(c));
}

/**
 * The daemon's plugin-MCP eligibility filter (design spec §9(4a) enforcement), extracted as a
 * pure predicate so it's unit-testable without booting a daemon: explicitly enabled, not
 * disabled, some MCP content declared (legacy `.mcp.json` OR manifest `contributes.mcpServers`),
 * AND every required consent class is on record. For legacy plugins `requiredConsents` is always
 * [] so `consentComplete` is vacuously true and behavior is byte-identical to pre-4a (enable
 * alone suffices). For a manifest plugin with exec content, enabling WITHOUT a consent record
 * leaves this false — the caller (daemon.ts) is expected to log why when that happens.
 */
export function pluginMcpEligible(p: PluginInfo): boolean {
  return p.mcpEnabled && !p.disabled && (p.hasMcp || p.hasManifestMcp) && consentComplete(p);
}
