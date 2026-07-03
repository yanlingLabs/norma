import type { Task } from "@norma/protocol";

/** Session-scoped agent task lists. Engine-memory (same lifecycle as loadedSkills) — the
 *  task_updated events are persisted for harness replay; the store itself is not (deferred). */
export class TaskStore {
  private sessions = new Map<string, Map<string, Task>>();

  private forSession(sessionId: string): Map<string, Task> {
    let m = this.sessions.get(sessionId);
    if (!m) { m = new Map(); this.sessions.set(sessionId, m); }
    return m;
  }

  create(sessionId: string, subject: string, activeForm?: string): Task {
    const m = this.forSession(sessionId);
    const task: Task = { id: String(m.size + 1), subject, status: "pending", ...(activeForm ? { activeForm } : {}) };
    m.set(task.id, task);
    return task;
  }

  update(sessionId: string, id: string, patch: { status?: Task["status"]; subject?: string; activeForm?: string }): Task | undefined {
    const m = this.forSession(sessionId);
    const t = m.get(id);
    if (!t) return undefined;
    const next: Task = { ...t, ...patch };
    m.set(id, next);
    return next;
  }

  list(sessionId: string): Task[] { return [...this.forSession(sessionId).values()]; }
}
