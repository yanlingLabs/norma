import type { Task } from "@norma/protocol";

/** Session-scoped agent task lists. Engine-memory (same lifecycle as loadedSkills) — the
 *  task_updated events are persisted for harness replay; the store itself is not (deferred).
 *
 *  Task descriptions (4g-ii, CC parity): @norma/protocol's `Task` has no `description` field
 *  (only id/subject/status/activeForm), and this task deliberately does NOT touch
 *  packages/protocol (a zero-fixture-drift constraint for this phase). So descriptions are kept
 *  in a SEPARATE per-session map here, core-side only — never merged into the `Task` objects
 *  returned by list()/create() or handed to `ctx.taskEvent`, which stay byte-identical to the
 *  wire `Task` shape (task.list's RPC response and the task_updated event's `task` field are
 *  UNCHANGED). A future task_get tool (Phase 4g Task 4) is expected to read `descriptionOf()`
 *  to surface it back to the model. */
export class TaskStore {
  private sessions = new Map<string, Map<string, Task>>();
  private descriptions = new Map<string, Map<string, string>>();

  private forSession(sessionId: string): Map<string, Task> {
    let m = this.sessions.get(sessionId);
    if (!m) { m = new Map(); this.sessions.set(sessionId, m); }
    return m;
  }

  private descFor(sessionId: string): Map<string, string> {
    let m = this.descriptions.get(sessionId);
    if (!m) { m = new Map(); this.descriptions.set(sessionId, m); }
    return m;
  }

  create(sessionId: string, subject: string, description: string, activeForm?: string): Task {
    const m = this.forSession(sessionId);
    const task: Task = { id: String(m.size + 1), subject, status: "pending", ...(activeForm ? { activeForm } : {}) };
    m.set(task.id, task);
    this.descFor(sessionId).set(task.id, description);
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

  /** Terminal removal — @norma/protocol's Task.status enum has no "deleted" value, so (per the
   *  task_create/task_update tool's design) deletion is modeled as OUTRIGHT REMOVAL from the
   *  store rather than an update to a "deleted" status: emitting a task_updated event with a
   *  fabricated status the wire schema doesn't declare would misrepresent the protocol. Returns
   *  false (no-op) if the id doesn't exist. */
  delete(sessionId: string, id: string): boolean {
    const existed = this.forSession(sessionId).delete(id);
    this.descFor(sessionId).delete(id);
    return existed;
  }

  list(sessionId: string): Task[] { return [...this.forSession(sessionId).values()]; }

  /** Core-side-only description lookup — see the class doc comment. undefined if the task was
   *  never created with one (shouldn't happen post-4g-ii: task_create requires it) or has since
   *  been deleted. */
  descriptionOf(sessionId: string, id: string): string | undefined {
    return this.descFor(sessionId).get(id);
  }
}
