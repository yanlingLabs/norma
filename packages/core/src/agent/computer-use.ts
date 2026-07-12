import type { PeripheralClass } from "../peripheral/broker";

// ---------------------------------------------------------------------------------------------
// ComputerUseService (Phase 5 CU) — lease lifecycle around PeripheralBroker for the `computer`
// tool. Requesters INSIDE core hit the broker in-process (2f §A1: "Requesters inside core (the
// engine, Phase 5g) hit the broker in-process"). A stateless tool run() cannot hold a lease across
// the CU loop, and re-leasing per action would raise an approval card on EVERY action under `ask`
// (2f: lease acquisition follows the session approval policy). So this service HOLDS one lease per
// (session, class): acquired lazily on first use, renewed by a per-session heartbeat, released on
// the session's turn completion (expiry is the backstop). Under `ask` that means ONE card per class
// per turn, not one per action.
//
// Every public method returns a typed result and NEVER throws across its surface (mirrors
// PeripheralBroker's convention). The broker + clock + scheduler are all injectable so the whole
// service is unit-tested with a fake broker — no Norma.app, no TCC, no real timers.
// ---------------------------------------------------------------------------------------------

/** The exact subset of PeripheralBroker this service depends on (kept narrow so tests inject a
 *  fake). Shapes mirror broker.ts's LeaseResult/RenewResult/ReleaseResult/CallResult unions. */
export interface PeripheralBrokerLike {
  lease(req: { sessionId: string; class: PeripheralClass }): Promise<
    | { leaseId: string; token: string; expiresAt: number }
    | { code: "lease_held"; holder: { kind: string; id: string } }
    | { code: "no_provider" }
    | { code: "denied" }
  >;
  renew(req: { leaseId: string; token: string }): { ok: true; expiresAt: number } | { code: string };
  release(req: { leaseId: string; token: string }): { ok: true } | { code: string };
  call(req: { leaseId: string; token: string; class: PeripheralClass; payloadJson: string }): Promise<
    | { ok: true; resultJson: string }
    | { code: "not_found" }
    | { code: "token_mismatch" }
    | { code: "expired" }
    | { code: "timeout" }
    | { code: "lease_gone"; reason: string }
    | { code: "provider_error"; message: string }
  >;
}

/** Injectable interval scheduler — the default uses real (unref'd) timers; tests capture the
 *  callback and drive it manually so heartbeat renewal is deterministic and clock-free. */
export interface CuScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: CuScheduler = {
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface ComputerUseServiceDeps {
  broker: PeripheralBrokerLike;
  /** Client-facing renewal cadence (spec-default 5000ms, settings.peripheral.heartbeatMs). */
  heartbeatMs?: number;
  now?: () => number;
  scheduler?: CuScheduler;
}

/** The tool-facing outcome of a CU action. `ok:false` carries a model-ready message and a `kind`
 *  the tool can use for logging/branching. `unavailable` is the spec-pinned "no provider / lease
 *  gone" case → message "computer use unavailable — Norma.app not running". */
export type CuActResult =
  | { ok: true; resultJson: string }
  | { ok: false; kind: "unavailable" | "denied" | "provider_error" | "timeout"; message: string };

interface HeldLease {
  leaseId: string;
  token: string;
  expiresAt: number;
}

interface SessionState {
  leases: Map<PeripheralClass, HeldLease>;
  timer: unknown | null;
}

/** Re-acquire a cached lease this many ms before its stated expiry — avoids racing a lease that is
 *  about to expire (the heartbeat normally keeps it well clear of this window). */
const EXPIRY_SKEW_MS = 1_000;

export const CU_UNAVAILABLE_MESSAGE = "computer use unavailable — Norma.app not running";

export class ComputerUseService {
  private readonly broker: PeripheralBrokerLike;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly scheduler: CuScheduler;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: ComputerUseServiceDeps) {
    this.broker = deps.broker;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Run one CU capability call for `sessionId`, ensuring a live lease for `cls` first. The single
   *  entry point the `computer` tool calls. Never throws. */
  async act(sessionId: string, cls: PeripheralClass, payloadJson: string): Promise<CuActResult> {
    const ensured = await this.ensureLease(sessionId, cls);
    if (!("leaseId" in ensured)) return this.mapLeaseError(ensured);

    const res = await this.broker.call({ leaseId: ensured.leaseId, token: ensured.token, class: cls, payloadJson });
    if ("ok" in res) return { ok: true, resultJson: res.resultJson }; // only the success member has `ok`

    // A LEASE-INVALIDATING failure drops the cached lease so the next action re-acquires (and,
    // under ask, re-cards) — the token/lease is genuinely gone. A provider_error/timeout leaves
    // the lease intact: the lease is fine, the capability call itself failed (e.g. TCC not granted,
    // a slow capture), and re-carding on the next action would be pure noise.
    if (res.code === "not_found" || res.code === "token_mismatch" || res.code === "expired" || res.code === "lease_gone") {
      this.dropLease(sessionId, cls);
      return { ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE };
    }
    if (res.code === "timeout") return { ok: false, kind: "timeout", message: "the computer-use action timed out" };
    return { ok: false, kind: "provider_error", message: res.message };
  }

  /** Release every lease held for `sessionId` and stop its heartbeat — called by the engine on the
   *  main thread's turn completion. Best-effort + synchronous (broker.release is sync); expiry is
   *  the backstop if this is ever missed. A no-op for a session that holds nothing. */
  releaseSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const held of state.leases.values()) {
      this.broker.release({ leaseId: held.leaseId, token: held.token });
    }
    this.stopTimer(state);
    this.sessions.delete(sessionId);
  }

  /** True if `sessionId` currently holds any lease (test/introspection helper). */
  holdsAny(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.leases.size ?? 0) > 0;
  }

  private async ensureLease(
    sessionId: string,
    cls: PeripheralClass,
  ): Promise<HeldLease | { code: "lease_held"; holder: { kind: string; id: string } } | { code: "no_provider" } | { code: "denied" }> {
    const state = this.sessions.get(sessionId);
    const cached = state?.leases.get(cls);
    if (cached && this.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached;

    const r = await this.broker.lease({ sessionId, class: cls });
    if (!("leaseId" in r)) return r; // typed lease error passes through
    const held: HeldLease = { leaseId: r.leaseId, token: r.token, expiresAt: r.expiresAt };
    const s = this.sessions.get(sessionId) ?? { leases: new Map(), timer: null };
    s.leases.set(cls, held);
    this.sessions.set(sessionId, s);
    this.armHeartbeat(sessionId, s);
    return held;
  }

  private mapLeaseError(
    err: { code: "lease_held"; holder: { kind: string; id: string } } | { code: "no_provider" } | { code: "denied" },
  ): CuActResult {
    if (err.code === "no_provider") return { ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE };
    if (err.code === "denied") return { ok: false, kind: "denied", message: "computer use was not permitted for this session" };
    return { ok: false, kind: "denied", message: `that peripheral is already controlled by ${err.holder.kind} ${err.holder.id}` };
  }

  private armHeartbeat(sessionId: string, state: SessionState): void {
    if (state.timer !== null) return; // one heartbeat per session
    state.timer = this.scheduler.setInterval(() => this.renewAll(sessionId), this.heartbeatMs);
  }

  /** Heartbeat tick: renew every held lease; drop any the broker won't renew (typed renew error).
   *  Stops the timer once the session holds nothing. Synchronous (broker.renew is sync). */
  private renewAll(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const [cls, held] of [...state.leases]) {
      const r = this.broker.renew({ leaseId: held.leaseId, token: held.token });
      if ("ok" in r) held.expiresAt = r.expiresAt; // success member only
      else state.leases.delete(cls);
    }
    if (state.leases.size === 0) {
      this.stopTimer(state);
      this.sessions.delete(sessionId);
    }
  }

  private dropLease(sessionId: string, cls: PeripheralClass): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.leases.delete(cls);
    if (state.leases.size === 0) {
      this.stopTimer(state);
      this.sessions.delete(sessionId);
    }
  }

  private stopTimer(state: SessionState): void {
    if (state.timer !== null) {
      this.scheduler.clearInterval(state.timer);
      state.timer = null;
    }
  }
}
