import { describe, expect, mock, test } from "bun:test";
import { makeApply, type SettingsApplyDeps } from "../src/settings-apply";
import { ToolRegistry } from "../src/agent/tools/registry";

const fakeReg = new ToolRegistry();

function baseDeps(overrides: Partial<SettingsApplyDeps> = {}): SettingsApplyDeps {
  return {
    setLiveSettings: () => {},
    registry: fakeReg,
    buildComputerService: () => ({}) as any,
    registerComputer: () => {},
    teardownComputer: () => {},
    computerInFlight: () => false,
    buildLspManager: () => ({}) as any,
    registerLsp: () => {},
    teardownLsp: () => {},
    ...overrides,
  };
}

describe("makeApply", () => {
  test("swap happens first, before any tool re-wire", async () => {
    const order: string[] = [];
    const apply = makeApply(
      baseDeps({
        setLiveSettings: () => order.push("swap"),
        buildComputerService: () => {
          order.push("build");
          return {} as any;
        },
        registerComputer: () => order.push("register"),
      }),
    );
    await apply({ computerUse: { enabled: false } } as any, { computerUse: { enabled: true } } as any);
    expect(order[0]).toBe("swap");
    expect(order).toContain("register");
  });

  test("computerUse false→true registers the computer tool + builds service", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const apply = makeApply(baseDeps({ buildComputerService: build, registerComputer: register }));
    await apply({ computerUse: { enabled: false } } as any, { computerUse: { enabled: true } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  test("computerUse true→false with an in-flight call drains before teardown", async () => {
    let inFlight = true;
    const teardown = mock(() => {});
    const apply = makeApply(
      baseDeps({ computerInFlight: () => inFlight, teardownComputer: teardown, drainIntervalMs: 5 }),
    );
    const p = apply({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    await Bun.sleep(30);
    expect(teardown).not.toHaveBeenCalled(); // still draining
    inFlight = false;
    await p;
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("computerUse disable drain exceeds drainTimeoutMs: teardown still called once, a warning is logged, test completes fast", async () => {
    const teardown = mock(() => {});
    const warnings: string[] = [];
    const apply = makeApply(
      baseDeps({
        computerInFlight: () => true, // never clears
        teardownComputer: teardown,
        drainTimeoutMs: 40,
        drainIntervalMs: 5,
        sleep: (_ms: number) => Promise.resolve(), // fast injected clock — no real waiting
        log: (msg) => warnings.push(msg),
      }),
    );
    const start = Date.now();
    await apply({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(warnings.length).toBe(1);
    expect(Date.now() - start).toBeLessThan(100); // never actually waited real ms, despite drainTimeoutMs

    // Same assertion with the PRODUCTION default drainTimeoutMs (10000ms) — the cap is expressed
    // as an iteration count over the injected sleep, not a real-time deadline, so a fast sleep
    // keeps this near-instant even at the real default cap (proves the drain cap doesn't secretly
    // depend on wall-clock time).
    const teardown2 = mock(() => {});
    const apply2 = makeApply(
      baseDeps({
        computerInFlight: () => true,
        teardownComputer: teardown2,
        sleep: (_ms: number) => Promise.resolve(),
        log: () => {},
      }),
    );
    const start2 = Date.now();
    await apply2({ computerUse: { enabled: true } } as any, { computerUse: { enabled: false } } as any);
    expect(teardown2).toHaveBeenCalledTimes(1);
    expect(Date.now() - start2).toBeLessThan(500);
  });

  test("lsp false→true registers, true→false tears down + stopAll", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    let apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register }));
    await apply({ lsp: { enabled: false } } as any, { lsp: { enabled: true } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);

    const teardown = mock(() => {});
    apply = makeApply(baseDeps({ teardownLsp: teardown }));
    await apply({ lsp: { enabled: true } } as any, { lsp: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  // lsp is default-ON / opt-out (absent block ⇒ enabled). These cross the absent-field boundary
  // the explicit-only tests above never touch — the exact class the `!!` polarity bug missed.
  test("lsp absent → {enabled:false} tears down", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // prev has NO lsp block = enabled-by-default; next explicitly disables → this IS a flip.
    await apply({ provider: { model: "a" } } as any, { lsp: { enabled: false } } as any);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test("lsp {enabled:false} → absent re-registers", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // prev explicitly disabled; next drops the lsp block = re-enabled by default → flip.
    await apply({ lsp: { enabled: false } } as any, { provider: { model: "a" } } as any);
    expect(build).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();
  });

  test("lsp absent → absent is a no-op", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(baseDeps({ buildLspManager: build, registerLsp: register, teardownLsp: teardown }));
    // both default-enabled (no lsp block on either side) → no flip.
    await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
    expect(build).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  test("computerUse absent → absent touches nothing (opt-in polarity: both default-OFF)", async () => {
    const build = mock(() => ({}) as any);
    const register = mock(() => {});
    const teardown = mock(() => {});
    const apply = makeApply(
      baseDeps({ buildComputerService: build, registerComputer: register, teardownComputer: teardown }),
    );
    // No computerUse block on either side ⇒ both disabled ⇒ no flip (CU is opt-in, unlike lsp).
    await apply({ provider: { model: "a" } } as any, { provider: { model: "b" } } as any);
    expect(build).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  test("a value-only change (no flag flip) swaps but touches NO tools", async () => {
    const buildCu = mock(() => ({}) as any);
    const registerCu = mock(() => {});
    const teardownCu = mock(() => {});
    const buildLsp = mock(() => ({}) as any);
    const registerLsp = mock(() => {});
    const teardownLsp = mock(() => {});
    let swapped: any;
    const apply = makeApply(
      baseDeps({
        setLiveSettings: (s) => {
          swapped = s;
        },
        buildComputerService: buildCu,
        registerComputer: registerCu,
        teardownComputer: teardownCu,
        buildLspManager: buildLsp,
        registerLsp,
        teardownLsp,
      }),
    );
    const prev = { computerUse: { enabled: true }, lsp: { enabled: true }, provider: { model: "a" } } as any;
    const next = { computerUse: { enabled: true }, lsp: { enabled: true }, provider: { model: "b" } } as any;
    await apply(prev, next);
    expect(swapped).toBe(next);
    for (const fn of [buildCu, registerCu, teardownCu, buildLsp, registerLsp, teardownLsp]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("CU and LSP flips are independent: a stalled CU drain does not block the LSP re-wire", async () => {
    const registerLsp = mock(() => {});
    const apply = makeApply(
      baseDeps({
        computerInFlight: () => true, // CU disable never clears within the drain window
        drainTimeoutMs: 30,
        drainIntervalMs: 5,
        registerLsp,
      }),
    );
    const start = Date.now();
    await apply(
      { computerUse: { enabled: true }, lsp: { enabled: false } } as any,
      { computerUse: { enabled: false }, lsp: { enabled: true } } as any,
    );
    expect(registerLsp).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(500); // bounded by the small drainTimeoutMs, not a real hang
  });
});
