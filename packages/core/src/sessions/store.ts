import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      last_seq INTEGER NOT NULL
    )`);
    this.recoverAll();
  }

  /** Index is disposable (spec §4.4): on open, validate each log's tail and resync last_seq. */
  private recoverAll(): void {
    const rows = this.db.query("SELECT session_id, scope FROM sessions").all() as { session_id: string; scope: string }[];
    for (const r of rows) {
      const path = this.logPath(r.scope, r.session_id);
      if (!existsSync(path)) continue;
      const good = this.readGoodLines(path);
      writeFileSync(path, good.map((l) => l + "\n").join("")); // drop truncated tail
      const lastSeq = good.length ? (JSON.parse(good[good.length - 1]!) as SessionEvent).seq : 0;
      this.db.run("UPDATE sessions SET last_seq = ? WHERE session_id = ?", [lastSeq, r.session_id]);
    }
  }

  private readGoodLines(path: string): string[] {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const good: string[] = [];
    for (const line of lines) {
      try { SessionEvent.parse(JSON.parse(line)); good.push(line); }
      catch { break; } // first bad line: everything after is suspect
    }
    return good;
  }

  private logPath(scope: string, sessionId: string): string {
    return join(this.homeDir, "sessions", scope, `${sessionId}.jsonl`);
  }

  createSession(scope: string): string {
    if (!SCOPE_RE.test(scope)) throw new Error(`invalid scope: ${scope}`);
    const sessionId = `s_${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.homeDir, "sessions", scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq) VALUES (?, ?, ?, 0)",
      [sessionId, scope, Date.now()],
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
    return this.readGoodLines(path)
      .map((l) => SessionEvent.parse(JSON.parse(l)))
      .filter((e) => e.seq > fromSeq);
  }

  list(): SessionRow[] {
    return (this.db.query("SELECT session_id, scope, created_at, last_seq FROM sessions ORDER BY created_at").all() as
      { session_id: string; scope: string; created_at: number; last_seq: number }[])
      .map((r) => ({ sessionId: r.session_id, scope: r.scope, createdAt: r.created_at, lastSeq: r.last_seq }));
  }

  close(): void { this.db.close(); }
}
