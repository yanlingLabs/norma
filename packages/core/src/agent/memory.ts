import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrustStore } from "./trust";

export type MemoryScope = "user" | "project";
export type MemoryType = "user" | "feedback" | "project" | "reference";
export interface MemoryFactMeta { name: string; description: string; type: MemoryType }
export interface MemoryFact extends MemoryFactMeta { body: string }
export interface MemoryAuditLine {
  ts: number;
  sessionId?: string;
  source: "tool" | "rpc";
  scope: MemoryScope;
  action: "write" | "delete";
  name: string;
  description?: string;
}
export type MemoryResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

const PROJECT_TRUST_ERROR = "project memory requires a trusted directory";

/** Slug jail — checked BEFORE any fs op touches a fact name. Lowercase alnum + dash, 1-64 chars,
 *  no path separators/dots: rules out `../x` traversal, `a/b` nesting, `A_B` (case/underscore),
 *  over-length names, and the empty string in one shot. */
function isValidSlug(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** Full name validation: slug jail + reserved names. Returns the error string, or null when valid.
 *
 *  `memory` is reserved because macOS's default APFS is case-insensitive/case-preserving:
 *  `memory.md` and the `MEMORY.md` index are the SAME file there, so an accepted fact named
 *  "memory" would be silently clobbered by the index rewrite (write reports ok but read fails,
 *  and every indexed fact vanishes from the index) — and delete("memory") would unlink the index
 *  itself. Compared case-insensitively even though the slug regex only admits lowercase, as
 *  defense against future regex loosening. (`audit` is NOT reserved: `audit.md` never collides
 *  with `audit.jsonl` — extensions differ even on a case-insensitive fs.) */
function nameError(name: string): string | null {
  if (!isValidSlug(name)) return `invalid memory name "${name}"`;
  if (name.toLowerCase() === "memory") return `"memory" is a reserved name (collides with the MEMORY.md index on case-insensitive filesystems)`;
  return null;
}

interface IndexEntry { name: string; description: string }

/** Parses a fact file's frontmatter + body. Tolerant: any missing/malformed piece → null (caller
 *  treats null as "corrupt", never throws). Mirrors the exact serialization in `factFileContent`
 *  so write→read is a byte-exact round trip. */
function parseFactFile(path: string): MemoryFact | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null; // missing, or a directory of that name
    raw = readFileSync(path, "utf8");
  } catch { return null; } // missing / permission-denied / unreadable
  if (!raw.startsWith("---")) return null; // no frontmatter fence
  const fenceEnd = raw.indexOf("\n---\n", 3);
  if (fenceEnd < 0) return null; // unterminated fence
  const fm = raw.slice(3, fenceEnd);
  // exactly one blank-line separator between the closing fence and the body (see factFileContent)
  const body = raw.slice(fenceEnd + 5).replace(/^\n/, "");
  let name = "";
  let description = "";
  let type = "";
  for (const line of fm.split("\n")) {
    const m = /^\s*(name|description|type)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2]!.trim();
    if (m[1] === "name") name = v;
    else if (m[1] === "description") description = v;
    else type = v;
  }
  if (!name || !description || !type) return null; // all three required
  return { name, description, type: type as MemoryType, body };
}

/** Serializes a fact to its on-disk form: frontmatter fence, one blank-line separator, then the
 *  body verbatim (no trailing newline forced) — this exact shape is what `parseFactFile` inverts. */
function factFileContent(fact: MemoryFact, description: string): string {
  return `---\nname: ${fact.name}\ndescription: ${description}\ntype: ${fact.type}\n---\n\n${fact.body}`;
}

/** MEMORY.md index lines look like `- [name](name.md) — description`; anything else (header,
 *  blank lines, corrupt lines) is ignored on read. */
function parseIndexEntries(indexPath: string): IndexEntry[] {
  let raw: string;
  try { raw = readFileSync(indexPath, "utf8"); } catch { return []; }
  const out: IndexEntry[] = [];
  const re = /^- \[(.+?)\]\(.+?\.md\) — (.*)$/;
  for (const line of raw.split("\n")) {
    const m = re.exec(line);
    if (m) out.push({ name: m[1]!, description: m[2]! });
  }
  return out;
}

function serializeIndex(entries: IndexEntry[]): string {
  const lines = ["# Memory index", ""];
  for (const e of entries) lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`);
  return lines.join("\n") + "\n";
}

/**
 * Fact-file memory store: `<name>.md` frontmatter files under a scope root, a `MEMORY.md` index
 * kept in sync on every write/delete, and an append-only `audit.jsonl` (bodies never included).
 * All mutations funnel through a single private promise chain so concurrent writes never
 * interleave their read-modify-write of MEMORY.md. Read paths (list/read/auditTail) are sync and
 * never throw — every failure mode is a typed `MemoryResult`/empty array, not an exception.
 */
export class MemoryStore {
  private readonly normaHome: string;
  private readonly trust: Pick<TrustStore, "isTrusted">;
  private readonly nowMs: () => number;
  /** Single-writer chain: every write()/delete() appends `.then(op)` here so mutations to the
   *  same (or different) scope's MEMORY.md never race. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: { normaHome: string; trust: Pick<TrustStore, "isTrusted">; nowMs?: () => number }) {
    this.normaHome = deps.normaHome;
    this.trust = deps.trust;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  /** user → `~/.norma/memory`; project → `<cwd>/.norma/memory`, gated on a trusted `cwd`. */
  private resolveRoot(scope: MemoryScope, cwd?: string): MemoryResult<string> {
    if (scope === "user") return { ok: true, value: join(this.normaHome, "memory") };
    if (!cwd || !this.trust.isTrusted(cwd)) return { ok: false, error: PROJECT_TRUST_ERROR };
    return { ok: true, value: join(cwd, ".norma", "memory") };
  }

  list(scope: MemoryScope, cwd?: string): MemoryResult<MemoryFactMeta[]> {
    const root = this.resolveRoot(scope, cwd);
    if (!root.ok) return root;
    let entries: string[];
    try {
      entries = readdirSync(root.value);
    } catch {
      return { ok: true, value: [] }; // dir missing (never written to yet)
    }
    const out: MemoryFactMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (nameError(name)) continue; // e.g. MEMORY.md itself (uppercase fails the slug; a stray reserved-name file on a case-SENSITIVE fs is also skipped)
      const parsed = parseFactFile(join(root.value, entry));
      if (!parsed) continue; // corrupt → skip, never throw
      out.push({ name: parsed.name, description: parsed.description, type: parsed.type });
    }
    return { ok: true, value: out };
  }

  read(scope: MemoryScope, name: string, cwd?: string): MemoryResult<MemoryFact> {
    const invalid = nameError(name);
    if (invalid) return { ok: false, error: invalid };
    const root = this.resolveRoot(scope, cwd);
    if (!root.ok) return root;
    const parsed = parseFactFile(join(root.value, `${name}.md`));
    if (!parsed) return { ok: false, error: `memory fact "${name}" not found or corrupt` };
    return { ok: true, value: parsed };
  }

  private appendAudit(line: MemoryAuditLine): void {
    // Audit ALWAYS lands under normaHome regardless of scope — a project-scope mutation is still
    // recorded centrally, never inside the (possibly untrusted-later, shared, or gitignored)
    // project directory.
    const auditPath = join(this.normaHome, "memory", "audit.jsonl");
    mkdirSync(dirname(auditPath), { recursive: true });
    // Built field-by-field (not a spread of `line`) so fact bodies can never leak in here,
    // structurally, no matter what a future caller passes. This is the SINGLE point of truth for
    // optional-field handling: callers pass sessionId/description as-is (possibly undefined), and
    // only here is an absent value OMITTED from the JSON rather than serialized as `null`.
    const obj: MemoryAuditLine = { ts: line.ts, source: line.source, scope: line.scope, action: line.action, name: line.name };
    if (line.sessionId !== undefined) obj.sessionId = line.sessionId;
    if (line.description !== undefined) obj.description = line.description;
    appendFileSync(auditPath, JSON.stringify(obj) + "\n", "utf8");
  }

  private doWrite(scope: MemoryScope, fact: MemoryFact, meta: { sessionId?: string; source: "tool" | "rpc" }, cwd?: string): MemoryResult {
    const invalid = nameError(fact.name);
    if (invalid) return { ok: false, error: invalid };
    const root = this.resolveRoot(scope, cwd);
    if (!root.ok) return root;

    const description = fact.description.split(/\r?\n/).join(" ").trim();
    // Wrapped: a genuine fs error (permission denied, disk full, root path colliding with a
    // plain file, ...) must become a typed ok:false — "never throws" is the store's contract,
    // and an uncaught throw would surface to the caller as a rejected write() promise.
    try {
      mkdirSync(root.value, { recursive: true });
      writeFileSync(join(root.value, `${fact.name}.md`), factFileContent(fact, description), "utf8");

      const indexPath = join(root.value, "MEMORY.md");
      const entries = parseIndexEntries(indexPath);
      const idx = entries.findIndex((e) => e.name === fact.name);
      if (idx >= 0) entries[idx] = { name: fact.name, description }; // overwrite keeps position
      else entries.push({ name: fact.name, description }); // new fact appends
      writeFileSync(indexPath, serializeIndex(entries), "utf8");

      this.appendAudit({ ts: this.nowMs(), sessionId: meta.sessionId, source: meta.source, scope, action: "write", name: fact.name, description });
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: `failed to write memory fact "${fact.name}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private doDelete(scope: MemoryScope, name: string, meta: { sessionId?: string; source: "tool" | "rpc" }, cwd?: string): MemoryResult {
    const invalid = nameError(name);
    if (invalid) return { ok: false, error: invalid };
    const root = this.resolveRoot(scope, cwd);
    if (!root.ok) return root;

    const path = join(root.value, `${name}.md`);
    if (!existsSync(path)) return { ok: false, error: `memory fact "${name}" not found` };
    try {
      unlinkSync(path);

      const indexPath = join(root.value, "MEMORY.md");
      const entries = parseIndexEntries(indexPath).filter((e) => e.name !== name);
      writeFileSync(indexPath, serializeIndex(entries), "utf8");

      this.appendAudit({ ts: this.nowMs(), sessionId: meta.sessionId, source: meta.source, scope, action: "delete", name });
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: `failed to delete memory fact "${name}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Queues `op` behind every previously-queued mutation so reads/writes of the same MEMORY.md
   *  never interleave, then returns that specific op's result. doWrite/doDelete's own try/catch
   *  converts every fs error into a typed result, so the `.catch` below is NOT reachable via fs
   *  failures — it guards the code that runs BEFORE those try blocks (nameError/resolveRoot,
   *  including a caller-supplied `trust.isTrusted` that throws): without it, one such throw would
   *  poison `this.queue` and every later mutation would inherit the rejection and silently no-op.
   *  Note the caller-facing `result` is deliberately NOT the caught promise — an escaped throw
   *  still rejects that one call loudly instead of being swallowed. */
  private enqueue(op: () => MemoryResult): Promise<MemoryResult> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }

  write(scope: MemoryScope, fact: MemoryFact, meta: { sessionId?: string; source: "tool" | "rpc" }, cwd?: string): Promise<MemoryResult> {
    return this.enqueue(() => this.doWrite(scope, fact, meta, cwd));
  }

  delete(scope: MemoryScope, name: string, meta: { sessionId?: string; source: "tool" | "rpc" }, cwd?: string): Promise<MemoryResult> {
    return this.enqueue(() => this.doDelete(scope, name, meta, cwd));
  }

  /** Newest LAST (file/append order) — caller slices further if it wants newest-first. Corrupt
   *  lines (bad JSON, or missing required fields) are skipped, never thrown. */
  auditTail(limit?: number): MemoryAuditLine[] {
    const auditPath = join(this.normaHome, "memory", "audit.jsonl");
    let raw: string;
    try { raw = readFileSync(auditPath, "utf8"); } catch { return []; }
    const out: MemoryAuditLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Partial<MemoryAuditLine>;
        if (typeof obj.ts === "number" && typeof obj.name === "string" && typeof obj.source === "string" && typeof obj.scope === "string" && typeof obj.action === "string") {
          out.push(obj as MemoryAuditLine);
        }
      } catch { /* corrupt line — skip */ }
    }
    return limit !== undefined ? out.slice(-limit) : out;
  }
}
