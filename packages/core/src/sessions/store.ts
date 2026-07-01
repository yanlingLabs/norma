import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionEvent, type NewSessionEvent } from "@norma/protocol";

// Keep in sync with SessionCreateParams scope regex (packages/protocol/src/methods.ts).
const SCOPE_RE = /^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/;

export interface SessionRow {
  sessionId: string;
  scope: string;
  createdAt: number;
  lastSeq: number;
}

/** Event payload before the store assigns seq/ts. Uses the protocol's exported
 *  NewSessionEvent (DistributedOmit over the union) so variant-specific fields type-check. */
export type EventInput = NewSessionEvent;

export class SessionStore {
  private db: Database;

  constructor(private readonly homeDir: string) {
    mkdirSync(join(homeDir, "sessions"), { recursive: true });
    this.db = new Database(join(homeDir, "sessions", "index.db"));
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      cwd TEXT,
      approval_policy TEXT NOT NULL DEFAULT 'ask'
    )`);
    // Handle pre-existing index.db files by adding missing columns
    for (const ddl of ["ALTER TABLE sessions ADD COLUMN cwd TEXT", "ALTER TABLE sessions ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'ask'"]) {
      try { this.db.run(ddl); }
      catch (e) {
        // Idempotent migration: only a re-added column is expected. Anything else is a real failure.
        if (!String((e as Error).message ?? e).includes("duplicate column")) throw e;
      }
    }
    this.recoverAll();
  }

  /** Index is disposable (spec §4.4): on open, scan log files on disk to rebuild the index,
   *  then resync last_seq for all known sessions. Corrupt lines are skipped (not stopped at);
   *  logs are rewritten only when bad lines were found, using a temp+rename atomic swap. */
  private recoverAll(): void {
    // Pass 1: resync sessions already in sqlite
    const rows = this.db.query("SELECT session_id, scope FROM sessions").all() as { session_id: string; scope: string }[];
    const known = new Set<string>();
    for (const r of rows) {
      known.add(r.session_id);
      const path = this.logPath(r.scope, r.session_id);
      if (!existsSync(path)) continue;
      const { good, sawBad } = this.readGoodLines(path);
      if (sawBad) {
        const tmp = path + ".repair";
        writeFileSync(tmp, good.map((l) => l + "\n").join(""));
        renameSync(tmp, path); // atomic: a crash never leaves a partial log
      }
      const lastSeq = good.length ? (JSON.parse(good[good.length - 1]!) as SessionEvent).seq : 0;
      this.db.run("UPDATE sessions SET last_seq = ? WHERE session_id = ?", [lastSeq, r.session_id]);
    }

    // Pass 2: scan filesystem for sessions not yet in sqlite (index rebuild from logs)
    const sessionsDir = join(this.homeDir, "sessions");
    let scopeDirs: string[];
    try { scopeDirs = readdirSync(sessionsDir); } catch { return; }
    for (const entry of scopeDirs) {
      if (entry === "index.db" || entry.startsWith("index.db")) continue;
      const scopeDir = join(sessionsDir, entry);
      let files: string[];
      try { files = readdirSync(scopeDir); } catch { continue; } // skip non-directories
      const scope = entry;
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -6); // strip .jsonl
        if (known.has(sessionId)) continue;
        const path = join(scopeDir, file);
        const { good, sawBad } = this.readGoodLines(path);
        if (good.length === 0) continue;
        if (sawBad) {
          const tmp = path + ".repair";
          writeFileSync(tmp, good.map((l) => l + "\n").join(""));
          renameSync(tmp, path);
        }
        const firstEvent = JSON.parse(good[0]!) as SessionEvent;
        const createdAt = firstEvent.ts;
        const lastSeq = (JSON.parse(good[good.length - 1]!) as SessionEvent).seq;
        // cwd/approval_policy are index-only metadata: after index loss they reset to defaults.
        this.db.run(
          "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy) VALUES (?, ?, ?, ?, NULL, 'ask')",
          [sessionId, scope, createdAt, lastSeq],
        );
        known.add(sessionId);
      }
    }
  }

  /** Parse all lines, skipping (not stopping at) unparseable ones. Returns both the raw
   *  good lines (used by recoverAll to rewrite the log verbatim) and the already-parsed
   *  events (used by read(), so callers don't have to re-parse JSON they already parsed here). */
  private readGoodLines(path: string): { good: string[]; parsed: SessionEvent[]; sawBad: boolean } {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const good: string[] = [];
    const parsed: SessionEvent[] = [];
    let sawBad = false;
    for (const line of lines) {
      try {
        const event = SessionEvent.parse(JSON.parse(line));
        good.push(line);
        parsed.push(event);
      }
      catch { sawBad = true; } // skip: a parseable line is a valid event regardless of position
    }
    return { good, parsed, sawBad };
  }

  private logPath(scope: string, sessionId: string): string {
    return join(this.homeDir, "sessions", scope, `${sessionId}.jsonl`);
  }

  createSession(scope: string, opts: { cwd?: string; approvalPolicy?: "ask" | "auto" } = {}): string {
    if (!SCOPE_RE.test(scope)) throw new Error(`invalid scope: ${scope}`);
    const sessionId = `s_${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.homeDir, "sessions", scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy) VALUES (?, ?, ?, 0, ?, ?)",
      [sessionId, scope, Date.now(), opts.cwd ?? null, opts.approvalPolicy ?? "ask"],
    );
    this.append(sessionId, { type: "session_created", sessionId, scope });
    return sessionId;
  }

  append(sessionId: string, input: EventInput): SessionEvent {
    const row = this.db.query("SELECT scope, last_seq FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; last_seq: number } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const event = SessionEvent.parse({ ...input, seq: row.last_seq + 1, ts: Date.now() });
    appendFileSync(this.logPath(row.scope, sessionId), JSON.stringify(event) + "\n");
    this.db.run("UPDATE sessions SET last_seq = ? WHERE session_id = ?", [event.seq, sessionId]);
    return event;
  }

  read(sessionId: string, fromSeq = 0): SessionEvent[] {
    const row = this.db.query("SELECT scope FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const path = this.logPath(row.scope, sessionId);
    if (!existsSync(path)) return [];
    return this.readGoodLines(path).parsed.filter((e) => e.seq > fromSeq);
  }

  list(): SessionRow[] {
    return (this.db.query("SELECT session_id, scope, created_at, last_seq FROM sessions ORDER BY created_at").all() as
      { session_id: string; scope: string; created_at: number; last_seq: number }[])
      .map((r) => ({ sessionId: r.session_id, scope: r.scope, createdAt: r.created_at, lastSeq: r.last_seq }));
  }

  meta(sessionId: string): { sessionId: string; scope: string; cwd: string | null; approvalPolicy: "ask" | "auto" } {
    const row = this.db.query("SELECT scope, cwd, approval_policy FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; cwd: string | null; approval_policy: string } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    return { sessionId, scope: row.scope, cwd: row.cwd, approvalPolicy: row.approval_policy === "auto" ? "auto" : "ask" };
  }

  close(): void { this.db.close(); }
}
