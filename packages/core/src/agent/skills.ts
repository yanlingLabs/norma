import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "./trust";

export interface SkillMeta { name: string; description: string; source: "project" | "user" | "self" | "plugin"; path: string }
interface ParsedSkill { name: string; description: string; body: string }
interface ScannedSkill extends ParsedSkill { source: SkillMeta["source"]; path: string }

const TRUNC = "\n[…truncated]";

/** Parse a SKILL.md: frontmatter (name, description) between the first ---…--- fence, then the body. null if invalid. */
function parseSkill(path: string, fallbackName: string): ParsedSkill | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null; // missing, or a directory named SKILL.md
    raw = readFileSync(path, "utf8");
  } catch { return null; } // missing / permission-denied / unreadable
  if (!raw.startsWith("---")) return null; // no frontmatter fence
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null; // unterminated fence
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  let name = "";
  let description = "";
  for (const line of fm.split("\n")) {
    const m = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (m[1] === "name") name = v; else description = v;
  }
  if (!name) name = fallbackName;
  if (!name || !description) return null; // both required
  return { name, description, body };
}

/** Cap `s` to `maxBytes` UTF-8 bytes on a byte boundary, appending a truncation marker when cut. Mirrors context.ts's capBytes. */
function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.byteLength <= maxBytes ? s : buf.subarray(0, maxBytes).toString("utf8") + TRUNC;
}

/** Scan `<root>/<dir>/SKILL.md` for every immediate subdirectory of `root`, skipping names in `exclude`. Skips anything invalid; never throws. */
function scanRoot(root: string, source: SkillMeta["source"], exclude?: Set<string>): ScannedSkill[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; } // root missing / unreadable
  const out: ScannedSkill[] = [];
  for (const dir of dirs) {
    if (exclude?.has(dir)) continue;
    const path = join(root, dir, "SKILL.md");
    const parsed = parseSkill(path, dir);
    if (parsed) out.push({ ...parsed, source, path });
  }
  return out;
}

const USER_ROOT_EXCLUDE = new Set(["self"]); // the self/ subdir is scanned separately, as source "self"

/**
 * Discovers SKILL.md skills from four sources:
 *  - project: `<cwd>/.norma/skills/*`   — TRUST-GATED (only when `trust.isTrusted(cwd)`)
 *  - user:    `~/.norma/skills/*`       — always (excludes the reserved `self/` subdir)
 *  - self:    `~/.norma/skills/self/*`  — always
 *  - plugin:  `~/.norma/plugins/<plugin>/skills/<skill>` — always, namespaced `<plugin>:<skill>`
 * Defensive throughout: malformed/missing/permission-denied skills are skipped, never thrown.
 */
export class SkillStore {
  private readonly normaHome: string;
  private readonly trust: TrustStore;
  private readonly bodyBytes: number;
  private readonly disabledPlugins: string[];

  constructor(deps: { normaHome: string; trust: TrustStore; caps?: { bodyBytes?: number }; plugins?: { disabled?: string[] } }) {
    this.normaHome = deps.normaHome;
    this.trust = deps.trust;
    this.bodyBytes = deps.caps?.bodyBytes ?? 32768;
    this.disabledPlugins = deps.plugins?.disabled ?? [];
  }

  /** All discovered skills (parsed, unfiltered by name), in precedence order: project, user, self, plugin. */
  private discover(cwd: string | null): ScannedSkill[] {
    const all: ScannedSkill[] = [];

    if (cwd && this.trust.isTrusted(cwd)) {
      all.push(...scanRoot(join(cwd, ".norma", "skills"), "project"));
    }

    all.push(...scanRoot(join(this.normaHome, "skills"), "user", USER_ROOT_EXCLUDE));
    all.push(...scanRoot(join(this.normaHome, "skills", "self"), "self"));

    let plugins: string[] = [];
    try {
      plugins = readdirSync(join(this.normaHome, "plugins"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* no plugins dir */ }
    for (const plugin of plugins) {
      if (this.disabledPlugins.includes(plugin)) continue;
      for (const s of scanRoot(join(this.normaHome, "plugins", plugin, "skills"), "plugin")) {
        all.push({ ...s, name: `${plugin}:${s.name}` }); // the one place plugin names get namespaced
      }
    }

    return all;
  }

  /** Lists all visible skills for `cwd` (project skills only when trusted). First occurrence wins on name collisions. */
  list(input: { cwd: string | null }): SkillMeta[] {
    const seen = new Set<string>();
    const out: SkillMeta[] = [];
    for (const s of this.discover(input.cwd)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, description: s.description, source: s.source, path: s.path });
    }
    return out;
  }

  /** Loads a skill's body (frontmatter stripped, byte-capped) by name, respecting the same trust gate and precedence as `list`. */
  load(name: string, input: { cwd: string | null }): { name: string; body: string } | null {
    for (const s of this.discover(input.cwd)) {
      if (s.name === name) return { name: s.name, body: capBytes(s.body, this.bodyBytes) };
    }
    return null;
  }
}
