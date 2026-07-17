import type { SessionEvent } from "@norma/protocol";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";

export interface DispatchChildrenDeps {
  store: SessionStore;
  hub: SessionHub;
  runTurn: (sessionId: string) => Promise<void>;
  isRunning: (sessionId: string) => boolean;
  // Dispatch (Phase 7) Task 5: stopChild's mechanism — daemon.ts wires the engine's own
  // interrupt(sessionId); tests hand a recording stub.
  interrupt: (sessionId: string) => void;
}

type ChildStatus = "running" | "awaiting_approval" | "awaiting_input" | "completed" | "error";

/** Live bookkeeping for one dispatch child. `status` is the ONLY thing rosterFor/statusOf ever
 *  read — everything else is scratch state onEvent/onTurnEnd use to compute the next status.
 *  `sawError`/`lastAssistant` are reset every turn-end (see onTurnEnd) so a NEXT turn's outcome
 *  is never contaminated by a previous one's. */
interface ChildState {
  title: string;
  dir: string;
  spawnedAt: number;
  status: ChildStatus;
  lastAssistant?: string;
  sawError?: boolean;
}

/** Dispatch (Phase 7): tracks the dispatch session's children. Task 4 ships spawnChild; Task 5
 *  adds derived status, completion wake (with same-drain coalescing), the roster reminder, and
 *  task_stop's dispatch-child branch. Task 6 adds the approval/question relay: onEvent below both
 *  tracks state AND mirrors the four relay-eligible event types into the dispatch stream (see
 *  `mirror` below) so a client attached ONLY to the dispatch session still sees/answers a child's
 *  approval or question. */
export class DispatchChildren {
  private children = new Map<string, ChildState>();
  private dispatchId?: string;
  // Wake coalescing: a BOOLEAN, not a counter/queue — multiple children finishing while the
  // dispatch turn is busy all collapse into exactly one follow-up wake, drained the next time the
  // dispatch session's OWN turn ends (see onTurnEnd's dispatchId branch).
  private pendingWake = false;
  private off?: () => void;

  constructor(private readonly deps: DispatchChildrenDeps) {}

  /** Daemon boot: rebuild the child set from the store (so a restart doesn't lose the roster) and
   *  subscribe to every future event via the hub's observer fan-out. Restart semantics (deliberate,
   *  per spec): a child's LIVE state (was it running, awaiting approval, mid-turn?) died with the
   *  old process — there is no way to recover it — so every child rebuilt here starts as
   *  "completed", the honest "we don't actually know, but it's not still running" default. */
  start(): void {
    this.dispatchId = this.deps.store.dispatchSessionId();
    if (this.dispatchId) {
      for (const r of this.deps.store.childrenOf(this.dispatchId)) {
        this.children.set(r.sessionId, {
          title: r.title ?? r.sessionId, dir: r.cwd ?? "?", spawnedAt: r.createdAt, status: "completed",
        });
      }
    }
    this.off = this.deps.hub.addObserver((e) => this.onEvent(e));
  }

  /** Creates a first-class, ordinary CODE session as a child of the dispatch session — own
   *  transcript, own turn loop, own entry in `session.list`. Not a subagent THREAD (spawn_agent's
   *  mechanism): a real sibling session, addressable/resumable/attachable like any other. Callers
   *  (the engine's session_spawn bridge) are responsible for ALL validation (absolute dir, non-
   *  empty prompt, known type/model) — this method does no rejection of its own, mirroring
   *  spawn_agent's own bridge/registry split where the bridge is the gate. */
  spawnChild(opts: { dispatchSessionId: string; dir: string; prompt: string; title: string }): string {
    const childId = this.deps.store.createSession("global", {
      cwd: opts.dir, approvalPolicy: "auto", origin: "dispatch-child", mode: "code",
      parentSessionId: opts.dispatchSessionId,
    });
    // set BEFORE runTurn (below) so onTurnEnd can't race a bookkeeping-less child — spawnChild is
    // fully synchronous up to the `void runTurn(...)` call, so this always lands first.
    this.dispatchId = opts.dispatchSessionId;
    this.children.set(childId, { title: opts.title, dir: opts.dir, spawnedAt: Date.now(), status: "running" });
    this.deps.hub.append(childId, { type: "user_message", sessionId: childId, threadId: "main", text: opts.prompt, clientName: "dispatch" });
    this.deps.hub.append(opts.dispatchSessionId, {
      type: "child_update", sessionId: opts.dispatchSessionId, threadId: "main",
      childSessionId: childId, status: "running", title: opts.title,
    });
    void this.deps.runTurn(childId).catch((e) => console.error("dispatch child turn failed:", e));
    return childId;
  }

  /** hub observer (every appended/broadcast event of EVERY session — see SessionHub.addObserver):
   *  narrowed to events whose sessionId is a TRACKED child; anything else (the dispatch session's
   *  own events, an unrelated code session, a detached child's events after it's been forgotten)
   *  is a no-op. THIS is also what makes mirroring loop-safe (Task 6): `mirror()` below appends its
   *  copy under the DISPATCH session's own sessionId, which is never a tracked child — so when that
   *  append re-enters this same observer, the guard above discards it just like any other
   *  dispatch-session event, instead of mirroring it a second time. */
  private onEvent(e: SessionEvent): void {
    const c = this.children.get(e.sessionId);
    if (!c) return;
    switch (e.type) {
      case "approval_requested":
        c.status = "awaiting_approval";
        this.mirror({ ...e, sessionId: this.dispatchId!, childSessionId: e.sessionId });
        break;
      case "approval_resolved":
        c.status = "running";
        this.mirror({ ...e, sessionId: this.dispatchId!, childSessionId: e.sessionId });
        break;
      case "question_asked":
        c.status = "awaiting_input";
        this.mirror({ ...e, sessionId: this.dispatchId!, childSessionId: e.sessionId });
        break;
      case "question_resolved":
        c.status = "running";
        this.mirror({ ...e, sessionId: this.dispatchId!, childSessionId: e.sessionId });
        break;
      case "assistant_message": c.lastAssistant = e.text; break;
      case "agent_error": c.sawError = true; break;
      default: break;
    }
  }

  /** Mirror a child's approval/question event into the dispatch stream. seq/ts are re-stamped by
   *  the store on append (stripped here first — hub.append's EventInput type is seq/ts-less); the
   *  copy carries childSessionId (already set by each case above) so a client that only sees the
   *  dispatch session can still answer at the CHILD's sessionId via the existing approval.respond/
   *  askUser.respond RPCs (broker/QuestionBroker are keyed sessionId:callId, daemon-global — no new
   *  RPC needed). */
  private mirror(e: Record<string, unknown> & { type: string }): void {
    // Double cast (via unknown): the widened Record<string, unknown> parameter has no statically
    // known seq/ts, so TS won't narrow it directly — but every real call (the four cases above)
    // always carries both (they're spread straight off a persisted SessionEvent).
    const { seq: _seq, ts: _ts, ...rest } = e as unknown as { seq: number; ts: number };
    // Cast: EventInput is a discriminated union keyed on `type`; the widened Record<string,
    // unknown> parameter above can't structurally narrow back to it, but every call site (the four
    // cases above) always passes an object shaped exactly like its own protocol schema plus the
    // optional childSessionId field (Task 1) — which the parse in store.append accepts.
    this.deps.hub.append(this.dispatchId!, rest as never);
  }

  /** Engine calls this from runTurn's `finally` for EVERY session (dispatch's own turns included —
   *  see the dispatchId branch below). Two disjoint jobs: (a) if this IS the dispatch session's own
   *  turn ending, drain a coalesced pending wake (a child finished while dispatch was busy); (b) if
   *  this is a TRACKED CHILD's turn ending, derive its terminal status, append a `child_update` to
   *  the dispatch stream, and wake the dispatch session (immediately if idle, or coalesce into
   *  `pendingWake` if it's still busy). Any other sessionId (an ordinary code session, an untracked
   *  id) is a no-op — this fires for every session in the daemon, not just dispatch-related ones. */
  onTurnEnd(sessionId: string): void {
    if (sessionId === this.dispatchId) {
      if (this.pendingWake) {
        this.pendingWake = false;
        void this.deps.runTurn(this.dispatchId).catch((e) => console.error("dispatch wake failed:", e));
      }
      return;
    }
    const c = this.children.get(sessionId);
    if (!c) return;
    const status: ChildStatus = c.sawError ? "error" : "completed";
    c.status = status;
    this.deps.hub.append(this.dispatchId!, {
      type: "child_update", sessionId: this.dispatchId!, threadId: "main",
      childSessionId: sessionId, status, title: c.title,
      ...(c.lastAssistant ? { resultSummary: c.lastAssistant.slice(0, 2000) } : {}),
    });
    // Reset per-turn scratch state AFTER building this turn's update (see ChildState doc):
    // children are real resumable sessions, so a LATER turn that ends without a fresh
    // assistant_message must not resurrect this turn's text as its resultSummary (nor inherit
    // this turn's error flag).
    c.sawError = false;
    c.lastAssistant = undefined;
    if (!this.deps.isRunning(this.dispatchId!)) {
      void this.deps.runTurn(this.dispatchId!).catch((e) => console.error("dispatch wake failed:", e));
    } else {
      this.pendingWake = true;
    }
  }

  /** Derived, never stored — exported for tests. Falls back to "completed" for an id this registry
   *  never tracked (or has forgotten): the closest honest reading of "definitely not running". */
  statusOf(childId: string): ChildStatus {
    return this.children.get(childId)?.status ?? "completed";
  }

  /** Per-turn live roster — non-undefined ONLY for the dispatch session itself (mirrors
   *  taskListReminder's own "nothing to remind about → undefined" contract, engine.ts). */
  rosterFor(sessionId: string): string | undefined {
    if (sessionId !== this.dispatchId || this.children.size === 0) return undefined;
    const lines = [...this.children.entries()].map(([id, c]) =>
      `- ${id} "${c.title}" (${c.dir}) — ${c.status}, ${Math.round((Date.now() - c.spawnedAt) / 1000)}s`);
    return `<system-reminder>\nDispatch children roster (live):\n${lines.join("\n")}\n</system-reminder>`;
  }

  /** task_stop's dispatch-child branch. Only the dispatch session itself may stop a child —
   *  anyone else (or an unknown id) gets undefined, which task-stop.ts falls through on (to
   *  bgRegistry, then its own not-found error) rather than treating as a hard error here. */
  stopChild(callerSessionId: string, id: string): string | undefined {
    if (callerSessionId !== this.dispatchId) return undefined;
    const c = this.children.get(id);
    if (!c) return undefined;
    this.deps.interrupt(id);
    return `stopped child session ${id} ("${c.title}")`;
  }
}
