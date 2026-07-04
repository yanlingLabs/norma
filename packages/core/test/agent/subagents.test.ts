import { describe, expect, test } from "bun:test";
import { SubagentManager } from "../../src/agent/subagents";

describe("SubagentManager", () => {
  test("never exceeds maxConcurrent; queue drains", async () => {
    const m = new SubagentManager({ maxConcurrent: 2, timeoutMs: 5000 });
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      m.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return "x";
      });
    const res = await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(res.every((r) => r.ok)).toBe(true);
  });

  test("timeout → {ok:false}", async () => {
    const m = new SubagentManager({ timeoutMs: 20 });
    const r = await m.run(() => new Promise((res) => setTimeout(res, 1000)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timed out");
  });

  test("thrown fn → {ok:false} with message", async () => {
    const m = new SubagentManager({});
    const r = await m.run(async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("boom") });
  });

  test("thrown non-Error (e.g. a bare string) → {ok:false} with the stringified value, not \"undefined\"", async () => {
    const m = new SubagentManager({});
    const r = await m.run(async () => {
      throw "boom-string";
    });
    expect(r).toEqual({ ok: false, error: "boom-string" });
  });

  test("slot released on throw (a queued task still runs)", async () => {
    const m = new SubagentManager({ maxConcurrent: 1, timeoutMs: 5000 });
    const first = m.run(async () => {
      throw new Error("first fails");
    });
    const second = m.run(async () => "second ok");
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(false);
    expect(r2).toEqual({ ok: true, value: "second ok" });
  });
});
