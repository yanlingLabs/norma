/**
 * BackgroundAgentRegistry — pure state tracker for detached (async) subagent
 * threads. Foundation for `run_in_background` on spawn_agent.
 *
 * Unlike BackgroundTaskRegistry (bg-registry.ts, which owns a ChildProcess +
 * output ring for backgrounded bash), this registry holds AGENT threads: the
 * child thread's live output already streams as ordinary thread events, so
 * there is nothing to buffer here — just lifecycle (running → terminal) and
 * the final result string. No process/thread spawning happens in this file;
 * the engine drives runThread and reports back via complete()/stop().
 *
 * Map-backed, never throws: every method is a total function over whatever
 * state exists (unknown ids are no-ops / undefined / false, never errors).
 */

export type AgentStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentEntry {
  agentId: string;
  sessionId: string;
  threadId: string;
  name?: string;
  status: AgentStatus;
  result?: string;
  startedAt: number;
  notified: boolean;
  abort: AbortController;
}

export interface RegisterInput {
  agentId: string;
  sessionId: string;
  threadId: string;
  name?: string;
  abort: AbortController;
}

export type RegisterResult = { ok: true } | { ok: false; error: string };

export class BackgroundAgentRegistry {
  private agents = new Map<string, AgentEntry>();

  /**
   * Registers a new running entry. Rejects (never throws) two cases:
   *  - `agentId` already registered (covers re-registering the same
   *    agentId, whether or not the name also matches — re-registration is
   *    always a caller bug, not a name-reuse question).
   *  - `name` already resolves to a DIFFERENT agentId in the same session
   *    (CC-style: a background-agent name must be unique per session so
   *    `get()` by name is unambiguous).
   */
  register(e: RegisterInput): RegisterResult {
    if (this.agents.has(e.agentId)) {
      return { ok: false, error: `agent '${e.agentId}' is already registered` };
    }
    if (e.name) {
      const existing = this.findByName(e.sessionId, e.name);
      if (existing) {
        return { ok: false, error: `name '${e.name}' already in use by agent ${existing.agentId}` };
      }
    }
    this.agents.set(e.agentId, {
      agentId: e.agentId,
      sessionId: e.sessionId,
      threadId: e.threadId,
      name: e.name,
      status: "running",
      startedAt: Date.now(),
      notified: false,
      abort: e.abort,
    });
    return { ok: true };
  }

  /** running → completed|failed, stores the result. No-op if unknown or already terminal. */
  complete(agentId: string, outcome: { ok: boolean; result: string }): void {
    const e = this.agents.get(agentId);
    if (!e || e.status !== "running") return;
    e.status = outcome.ok ? "completed" : "failed";
    e.result = outcome.result;
  }

  /**
   * If running: fires `entry.abort.abort()`, flips status → stopped, returns true.
   * Otherwise (unknown id or already terminal) returns false and does nothing.
   * The abort signal's effect on the actual child thread (interrupting runThread)
   * is wired by the engine — this method only fires the controller + updates state.
   */
  stop(agentId: string): boolean {
    const e = this.agents.get(agentId);
    if (!e || e.status !== "running") return false;
    e.abort.abort();
    e.status = "stopped";
    return true;
  }

  /**
   * Looks up by agentId first; if not found (or found but scoped out of
   * `sessionId`), falls back to a by-name lookup (optionally scoped to
   * `sessionId`). An id that resolves to an entry in a DIFFERENT session
   * than the one requested returns undefined rather than falling through
   * to a name search on the same string.
   */
  get(idOrName: string, sessionId?: string): AgentEntry | undefined {
    const byId = this.agents.get(idOrName);
    if (byId) return !sessionId || byId.sessionId === sessionId ? byId : undefined;
    for (const e of this.agents.values()) {
      if (e.name === idOrName && (!sessionId || e.sessionId === sessionId)) return e;
    }
    return undefined;
  }

  /** All entries (running + terminal) for a session, in registration order. */
  list(sessionId: string): AgentEntry[] {
    return [...this.agents.values()].filter((e) => e.sessionId === sessionId);
  }

  /**
   * Returns terminal (completed/failed/stopped) entries for `sessionId` that
   * haven't been notified yet, marking each `notified: true` as it's
   * returned. Idempotent: entries already notified are skipped, so a second
   * call with no new completions in between returns [].
   */
  takeCompletedForSession(sessionId: string): AgentEntry[] {
    const taken: AgentEntry[] = [];
    for (const e of this.agents.values()) {
      if (e.sessionId !== sessionId || e.status === "running" || e.notified) continue;
      e.notified = true;
      taken.push(e);
    }
    return taken;
  }

  private findByName(sessionId: string, name: string): AgentEntry | undefined {
    for (const e of this.agents.values()) {
      if (e.sessionId === sessionId && e.name === name) return e;
    }
    return undefined;
  }
}
