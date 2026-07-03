export type PlanOutcome =
  | { approved: boolean; feedback?: string; autoAccept: boolean; by: string }
  | { timedOut: true };

/** In-flight exit_plan_mode plans, keyed by sessionId+callId. First response wins (mirrors QuestionBroker/ApprovalBroker). */
export class PlanBroker {
  private pending = new Map<string, { resolve: (o: PlanOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  private key(sessionId: string, callId: string): string { return `${sessionId}:${callId}`; }

  wait(sessionId: string, callId: string, timeoutMs: number): Promise<PlanOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, callId);
      const timer = setTimeout(() => { this.pending.delete(k); resolve({ timedOut: true }); }, timeoutMs);
      this.pending.set(k, { resolve, timer });
    });
  }

  respond(
    sessionId: string,
    callId: string,
    r: { approved: boolean; feedback?: string; autoAccept: boolean },
    by: string,
  ): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, callId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ ...r, by });
    return { ok: true, alreadyResolved: false };
  }
}
