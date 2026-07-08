import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "./trust";

export interface ResolvedAgent { instructions: string; model?: string; allowTools?: Set<string> }
export interface AgentMeta { name: string; description: string; source: "user" | "project" | "plugin" }
interface ParsedAgentDef { name: string; description: string; model?: string; tools?: string; body: string }
interface ScannedAgentDef extends ParsedAgentDef { source: AgentMeta["source"] }

/** The system-prompt overlay used when `agentType` is omitted or doesn't match any discovered def. */
export const GENERAL_OVERLAY =
  "You are a capable autonomous subagent. Complete the delegated task using your tools and return a concise final report. You cannot ask the user questions.";

const DEFAULT_BASE_INSTRUCTIONS = "You are Norma, an agentic assistant running as a delegated subagent.";

/** Parse an agent def `<name>.md`: frontmatter (name, description, model?, tools?) between the first ---…--- fence, then the body. null if invalid. */
function parseAgentDef(path: string, fallbackName: string): ParsedAgentDef | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null; // missing, or a directory
    raw = readFileSync(path, "utf8");
  } catch { return null; } // missing / permission-denied / unreadable
  if (!raw.startsWith("---")) return null; // no frontmatter fence
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null; // unterminated fence
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  let name = "";
  let description = "";
  let model: string | undefined;
  let tools: string | undefined;
  for (const line of fm.split("\n")) {
    const m = /^\s*(name|description|model|tools)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (m[1] === "name") name = v;
    else if (m[1] === "description") description = v;
    else if (m[1] === "model") model = v || undefined;
    else if (m[1] === "tools") tools = v || undefined;
  }
  if (!name) name = fallbackName;
  if (!name || !description) return null; // both required
  return { name, description, model, tools, body };
}

/** Scan `<root>/*.md` for agent defs. Skips anything invalid; never throws. */
function scanAgentDir(root: string, source: AgentMeta["source"]): ScannedAgentDef[] {
  let files: string[];
  try {
    files = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch { return []; } // root missing / unreadable
  const out: ScannedAgentDef[] = [];
  for (const file of files) {
    const parsed = parseAgentDef(join(root, file), file.slice(0, -3));
    if (parsed) out.push({ ...parsed, source });
  }
  return out;
}

/**
 * Resolves a subagent_type (agentType) to a system-prompt overlay + model + tool restriction.
 * Discovers agent defs from:
 *  - project: `<cwd>/.norma/agents/*.md` — TRUST-GATED (only when `trust.isTrusted(cwd)`)
 *  - user:    `<normaHome>/agents/*.md`  — always
 *  - plugin:  `<normaHome>/plugins/<plugin>/agents/*.md` — always (excluding disabled plugins),
 *    namespaced `<plugin>:<agent>`, same pattern as SkillStore's plugin skills (design spec §2:
 *    "same trust posture as skills" — always live, not gated on `settings.plugins.enabled`).
 * Precedence: project > user > plugin (plugin scanned last).
 * Unknown / omitted agentType resolves to a general-purpose fallback (no model, no tool restriction).
 * Defensive throughout: malformed/missing/permission-denied defs are skipped, never thrown.
 * Mirrors SkillStore's discovery + frontmatter-parse pattern.
 */
export class AgentStore {
  private readonly normaHome: string;
  private readonly trust: TrustStore;
  private readonly baseInstructions: string;
  private readonly disabledPlugins: string[];

  constructor(deps: { normaHome: string; trust: TrustStore; baseInstructions?: string; plugins?: { disabled?: string[] } }) {
    this.normaHome = deps.normaHome;
    this.trust = deps.trust;
    this.baseInstructions = deps.baseInstructions ?? DEFAULT_BASE_INSTRUCTIONS;
    this.disabledPlugins = deps.plugins?.disabled ?? [];
  }

  /** All discovered agent defs (parsed, unfiltered by name), in precedence order: project, user, plugin. */
  private discover(cwd: string | null): ScannedAgentDef[] {
    const all: ScannedAgentDef[] = [];
    if (cwd && this.trust.isTrusted(cwd)) {
      all.push(...scanAgentDir(join(cwd, ".norma", "agents"), "project"));
    }
    all.push(...scanAgentDir(join(this.normaHome, "agents"), "user"));

    let plugins: string[] = [];
    try {
      plugins = readdirSync(join(this.normaHome, "plugins"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* no plugins dir */ }
    for (const plugin of plugins) {
      if (this.disabledPlugins.includes(plugin)) continue;
      for (const a of scanAgentDir(join(this.normaHome, "plugins", plugin, "agents"), "plugin")) {
        all.push({ ...a, name: `${plugin}:${a.name}` }); // the one place plugin agent names get namespaced
      }
    }

    return all;
  }

  /** Resolves `agentType` to instructions/model/allowTools. Unknown or omitted agentType → general-purpose. */
  resolve(agentType: string | undefined, cwd: string | null): ResolvedAgent {
    if (agentType) {
      for (const def of this.discover(cwd)) {
        if (def.name === agentType) {
          return {
            instructions: `${this.baseInstructions}\n\n${def.body}`,
            model: def.model,
            allowTools: def.tools ? new Set(def.tools.split(",").map((s) => s.trim()).filter(Boolean)) : undefined,
          };
        }
      }
    }
    return { instructions: `${this.baseInstructions}\n\n${GENERAL_OVERLAY}` };
  }

  /** Lists all visible agent defs for `cwd` (project defs only when trusted). First occurrence wins on name collisions. */
  list(cwd?: string | null): Array<{ name: string; description: string; source: AgentMeta["source"] }> {
    const seen = new Set<string>();
    const out: Array<{ name: string; description: string; source: AgentMeta["source"] }> = [];
    for (const d of this.discover(cwd ?? null)) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ name: d.name, description: d.description, source: d.source });
    }
    return out;
  }
}
