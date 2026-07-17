import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";

export interface DispatchChildrenDeps {
  store: SessionStore;
  hub: SessionHub;
  runTurn: (sessionId: string) => Promise<void>;
  isRunning: (sessionId: string) => boolean;
}

/** Dispatch (Phase 7): tracks the dispatch session's children. Task 4 ships spawnChild; Task 5
 *  adds observation (status/wake/roster), Task 6 adds the approval/question relay. */
export class DispatchChildren {
  constructor(private readonly deps: DispatchChildrenDeps) {}

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
    this.deps.hub.append(childId, { type: "user_message", sessionId: childId, threadId: "main", text: opts.prompt, clientName: "dispatch" });
    this.deps.hub.append(opts.dispatchSessionId, {
      type: "child_update", sessionId: opts.dispatchSessionId, threadId: "main",
      childSessionId: childId, status: "running", title: opts.title,
    });
    void this.deps.runTurn(childId).catch((e) => console.error("dispatch child turn failed:", e));
    return childId;
  }
}
