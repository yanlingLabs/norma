import { describe, expect, test } from "bun:test";
import { ComputerUseService, CU_UNAVAILABLE_MESSAGE, type PeripheralBrokerLike, type CuScheduler } from "../../src/agent/computer-use";

// A fully scriptable fake PeripheralBroker + a manual scheduler, so lease lifecycle / heartbeat /
// error mapping are exercised with zero real timers and zero Norma.app.
class FakeBroker implements PeripheralBrokerLike {
  leaseCalls: Array<{ sessionId: string; class: string }> = [];
  renewCalls: Array<{ leaseId: string }> = [];
  releaseCalls: Array<{ leaseId: string }> = [];
  callCalls: Array<{ leaseId: string; token: string; class: string; payloadJson: string }> = [];
  private leaseSeq = 0;
  // scripted overrides
  leaseResult: any = null; // when set, returned instead of a fresh grant
  renewResult: any = null;
  callResult: any = { ok: true, resultJson: "{}" };
  expiresAt = 100_000;

  async lease(req: { sessionId: string; class: any }) {
    this.leaseCalls.push({ sessionId: req.sessionId, class: req.class });
    if (this.leaseResult) return this.leaseResult;
    return { leaseId: `lease_${this.leaseSeq++}`, token: `tok_${this.leaseSeq}`, expiresAt: this.expiresAt };
  }
  renew(req: { leaseId: string; token: string }) {
    this.renewCalls.push({ leaseId: req.leaseId });
    return this.renewResult ?? { ok: true as const, expiresAt: this.expiresAt + 15_000 };
  }
  release(req: { leaseId: string; token: string }) {
    this.releaseCalls.push({ leaseId: req.leaseId });
    return { ok: true as const };
  }
  async call(req: { leaseId: string; token: string; class: any; payloadJson: string }) {
    this.callCalls.push({ leaseId: req.leaseId, token: req.token, class: req.class, payloadJson: req.payloadJson });
    return this.callResult;
  }
}

/** Manual scheduler: captures the heartbeat fn so a test can `tick()` it deterministically. */
function manualScheduler() {
  const fns: Array<() => void> = [];
  const scheduler: CuScheduler = {
    setInterval(fn) { fns.push(fn); return fns.length - 1; },
    clearInterval(handle) { fns[handle as number] = () => {}; },
  };
  return { scheduler, tick: () => fns.forEach((f) => f()) };
}

function makeService(broker: FakeBroker, nowMs = 0) {
  const { scheduler, tick } = manualScheduler();
  let now = nowMs;
  const svc = new ComputerUseService({ broker, heartbeatMs: 5_000, now: () => now, scheduler });
  return { svc, tick, setNow: (n: number) => { now = n; } };
}

describe("ComputerUseService", () => {
  test("act acquires a lease then calls the broker with lease+token+class+payload", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "screenshot", '{"op":"screenshot"}');
    expect(r).toEqual({ ok: true, resultJson: "{}" });
    expect(broker.leaseCalls).toEqual([{ sessionId: "s1", class: "screenshot" }]);
    expect(broker.callCalls[0]).toMatchObject({ class: "screenshot", payloadJson: '{"op":"screenshot"}', leaseId: "lease_0" });
  });

  test("a held lease is reused across acts of the same class — leased ONCE", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "input-drive", "{}");
    await svc.act("s1", "input-drive", "{}");
    await svc.act("s1", "input-drive", "{}");
    expect(broker.leaseCalls.length).toBe(1);
    expect(broker.callCalls.length).toBe(3);
  });

  test("distinct classes lease independently", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "ax-read", "{}");
    expect(broker.leaseCalls.map((c) => c.class).sort()).toEqual(["ax-read", "screenshot"]);
  });

  test("no_provider on lease → the pinned 'unavailable' message", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "no_provider" };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE });
    expect(broker.callCalls.length).toBe(0); // never called the capability
  });

  test("denied on lease → denied kind", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "denied" };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("denied");
  });

  test("lease_held on lease → denied kind naming the holder", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "lease_held", holder: { kind: "session", id: "other" } };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe("denied"); expect(r.message).toContain("other"); }
  });

  test("lease_gone on call → unavailable AND the cached lease is dropped (next act re-leases)", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}"); // lease #1
    broker.callResult = { code: "lease_gone", reason: "provider-gone" };
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE });
    // next act re-leases (cache dropped)
    broker.callResult = { ok: true, resultJson: "{}" };
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(2);
    expect(svc.holdsAny("s1")).toBe(true);
  });

  test("provider_error on call → passed through verbatim, lease KEPT (no re-lease next act)", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}"); // lease #1
    broker.callResult = { code: "provider_error", message: "screen recording permission not granted" };
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "provider_error", message: "screen recording permission not granted" });
    broker.callResult = { ok: true, resultJson: "{}" };
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(1); // still the original lease
  });

  test("timeout on call → timeout kind, lease kept", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "input-drive", "{}");
    broker.callResult = { code: "timeout" };
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
    expect(broker.leaseCalls.length).toBe(1);
  });

  test("heartbeat renews every held lease and updates expiry", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "ax-read", "{}");
    tick();
    expect(broker.renewCalls.length).toBe(2);
  });

  test("heartbeat drops a lease the broker refuses to renew", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    broker.renewResult = { code: "expired" };
    tick();
    expect(svc.holdsAny("s1")).toBe(false);
    // next act re-leases
    broker.renewResult = null;
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(2);
  });

  test("a near-expiry cached lease is re-acquired on the next act", async () => {
    const broker = new FakeBroker();
    broker.expiresAt = 10_000;
    const { svc, setNow } = makeService(broker, 0);
    await svc.act("s1", "screenshot", "{}");
    setNow(9_500); // within EXPIRY_SKEW_MS (1000) of expiresAt=10000
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(2);
  });

  test("releaseSession releases every held lease and clears state", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "input-drive", "{}");
    svc.releaseSession("s1");
    expect(broker.releaseCalls.length).toBe(2);
    expect(svc.holdsAny("s1")).toBe(false);
    // heartbeat is stopped: a tick renews nothing
    tick();
    expect(broker.renewCalls.length).toBe(0);
  });

  test("releaseSession on an unknown session is a no-op", () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    expect(() => svc.releaseSession("nope")).not.toThrow();
    expect(broker.releaseCalls.length).toBe(0);
  });
});
