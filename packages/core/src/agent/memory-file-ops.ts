import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  nameError, parseFactFile, parseIndexEntries, serializeIndex, factFileContent,
  type MemoryFact, type MemoryFactMeta, type MemoryResult,
} from "./memory";

/**
 * T2 (design doc "dashboard rewire"): directory-generic fact-file CRUD, the file-backed twin of
 * `MemoryStore`'s scope-based one — used by `ipc/server.ts`'s memory.* RPC handlers when
 * `memory.enabled` (T1) is on, operating directly on a MEMDIR path (`memoryDirFor`/
 * `globalMemoryDirFor`, memory-dir.ts) instead of a `{scope, cwd}` pair. Deliberately NOT trust-
 * gated — T1's own write-root join (daemon.ts's `sessionDirs`) already treats MEMDIR as an
 * ungated, auto-provisioned root (the "tmpDir precedent"), so these RPC-facing ops mirror that:
 * whatever directory the caller (or the model, via a plain `write`) can already reach, these can
 * read/list/delete too. Shares `MemoryStore`'s exact on-disk shape (frontmatter + MEMORY.md index)
 * via its exported parse/serialize helpers — a fact written by the MODEL (plain `write` tool) and
 * one written/deleted through these RPCs round-trip identically.
 */

/** List every valid fact directly under `dir` — tolerant, same "corrupt/invalid → skip, never
 *  throw" contract as `MemoryStore.list`. A missing directory (no facts saved yet) is `[]`, not an
 *  error. `.audit.jsonl` and `MEMORY.md` itself are naturally excluded: the former isn't `.md`, the
 *  latter's stem ("MEMORY") fails the lowercase slug jail, same as the legacy store's own list(). */
export function listMemoryDir(dir: string): MemoryFactMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryFactMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (nameError(name)) continue;
    const parsed = parseFactFile(join(dir, entry));
    if (!parsed) continue;
    out.push({ name: parsed.name, description: parsed.description, type: parsed.type });
  }
  return out;
}

/** Read one fact by name from `dir`. Same typed-result contract as `MemoryStore.read`. */
export function readMemoryDir(dir: string, name: string): MemoryResult<MemoryFact> {
  const invalid = nameError(name);
  if (invalid) return { ok: false, error: invalid, kind: "invalid" };
  const parsed = parseFactFile(join(dir, `${name}.md`));
  if (!parsed) return { ok: false, error: `memory fact "${name}" not found or corrupt`, kind: "not_found" };
  return { ok: true, value: parsed };
}

/** Write one fact into `dir` (creating it on demand) and upsert its MEMORY.md index line. Same
 *  normalization/validation as `MemoryStore.doWrite` (multiline description collapsed to one line;
 *  an empty-after-normalization description is rejected — it would otherwise write a fact `read()`
 *  can't parse back and `list()` silently drops). No audit line: T2's brief scopes the restored
 *  audit trail to the RPC DELETE path only (model-side writes need none — the session transcript
 *  is the audit for those; an RPC-driven write is likewise not a destructive action worth logging
 *  the way a delete is). */
export function writeMemoryDir(dir: string, fact: MemoryFact): MemoryResult {
  const invalid = nameError(fact.name);
  if (invalid) return { ok: false, error: invalid, kind: "invalid" };
  const description = fact.description.split(/\r?\n/).join(" ").trim();
  if (!description) return { ok: false, error: `memory fact "${fact.name}" needs a non-empty description`, kind: "invalid" };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${fact.name}.md`), factFileContent(fact, description), "utf8");

    const indexPath = join(dir, "MEMORY.md");
    const entries = parseIndexEntries(indexPath);
    const idx = entries.findIndex((e) => e.name === fact.name);
    if (idx >= 0) entries[idx] = { name: fact.name, description };
    else entries.push({ name: fact.name, description });
    writeFileSync(indexPath, serializeIndex(entries), "utf8");
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: `failed to write memory fact "${fact.name}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** T2 bullet 3 ("cheap restoration" of T1's flagged audit-trail loss): a minimal per-delete line
 *  appended to `<dir>/.audit.jsonl` — deliberately NOT the legacy `MemoryAuditLine` shape (no
 *  sessionId/source/scope/description): this is the ONLY MEMDIR mutation that gets one, scoped to
 *  exactly the RPC delete path (see `deleteMemoryDir` below). */
export interface MemDirAuditLine { ts: number; op: "delete"; name: string }

function appendMemDirAudit(dir: string, line: MemDirAuditLine): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, ".audit.jsonl"), JSON.stringify(line) + "\n", "utf8");
}

/** Delete one fact from `dir`, drop its MEMORY.md index line, and append a `.audit.jsonl` line
 *  recording the deletion (ts/op/name) — restores, at the RPC boundary, the audit visibility a
 *  plain `unlinkSync` (what the model itself would do via the `edit`/`write`-adjacent tools) can't
 *  provide on its own. `nowMs` is injectable for deterministic tests, same convention as
 *  `MemoryStore`'s own constructor-level `nowMs` dep. */
export function deleteMemoryDir(dir: string, name: string, nowMs: () => number = Date.now): MemoryResult {
  const invalid = nameError(name);
  if (invalid) return { ok: false, error: invalid, kind: "invalid" };
  const path = join(dir, `${name}.md`);
  if (!existsSync(path)) return { ok: false, error: `memory fact "${name}" not found`, kind: "not_found" };
  try {
    unlinkSync(path);

    const indexPath = join(dir, "MEMORY.md");
    const entries = parseIndexEntries(indexPath).filter((e) => e.name !== name);
    writeFileSync(indexPath, serializeIndex(entries), "utf8");

    appendMemDirAudit(dir, { ts: nowMs(), op: "delete", name });
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: `failed to delete memory fact "${name}": ${err instanceof Error ? err.message : String(err)}` };
  }
}
