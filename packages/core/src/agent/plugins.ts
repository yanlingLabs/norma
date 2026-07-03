import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PluginManifest = z.object({
  name: z.string().optional(), description: z.string().optional(),
  version: z.string().optional(), author: z.string().optional(),
});

export interface PluginInfo { name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean }

/** Reads ~/.norma/plugins/<name>/. The DIRECTORY NAME is the canonical plugin name; plugin.json is metadata only (malformed → ignored, the plugin still loads). */
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
      let meta: z.infer<typeof PluginManifest> = {};
      try { meta = PluginManifest.parse(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))); }
      catch { this.deps.log?.(`plugin ${name}: no/invalid plugin.json (loading anyway)`); }
      let skills: string[] = [];
      try { skills = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md"))).map((e) => e.name); } catch { /* no skills dir */ }
      const isDisabled = disabled.includes(name);
      return { name, description: meta.description, version: meta.version, skills, hasMcp: existsSync(join(dir, ".mcp.json")), mcpEnabled: enabled.includes(name) && !isDisabled, disabled: isDisabled };
    });
  }
}
