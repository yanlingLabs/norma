export interface ApprovalOutcome { approved: boolean; by: string }

/** In-flight approval requests, keyed by sessionId+callId. First response wins (spec §4.10). */
export class ApprovalBroker {
  private pending = new Map<string, { resolve: (o: ApprovalOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  private key(sessionId: string, callId: string): string { return `${sessionId}:${callId}`; }

  wait(sessionId: string, callId: string, timeoutMs: number): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, callId);
      const timer = setTimeout(() => {
        this.pending.delete(k);
        resolve({ approved: false, by: "timeout" }); // fail-closed: no answer means no
      }, timeoutMs);
      this.pending.set(k, { resolve, timer });
    });
  }

  resolve(sessionId: string, callId: string, approved: boolean, by: string): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, callId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ approved, by });
    return { ok: true, alreadyResolved: false };
  }
}
