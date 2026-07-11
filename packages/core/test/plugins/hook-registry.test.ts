import { describe, expect, test } from "bun:test";
import { HookRegistry, HookFacade } from "../../src/plugins/hook-registry";
import type { HookEventPayload, HookResult, HookRunner, HookSpec } from "../../src/plugins/hook-runner";

describe("HookRegistry", () => {
  test("rebuild + hooksFor: flat per-event index, plugin order preserved, cwd = plugin dir", () => {
    const reg = new HookRegistry();
    reg.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a-pre.sh" }, { event: "post-tool", command: "./a-post.sh" }] },
      { id: "beta", dir: "/plugins/beta", hooks: [{ event: "pre-tool", command: "./b-pre.sh", timeoutMs: 250 }] },
    ]);

    const preTool = reg.hooksFor("pre-tool");
    expect(preTool).toEqual([
      { pluginId: "alpha", command: "./a-pre.sh", cwd: "/plugins/alpha" },
      { pluginId: "beta", command: "./b-pre.sh", cwd: "/plugins/beta", timeoutMs: 250 },
    ]);

    const postTool = reg.hooksFor("post-tool");
    expect(postTool).toEqual([{ pluginId: "alpha", command: "./a-post.sh", cwd: "/plugins/alpha" }]);
  });

  test("hooksFor an event with no hooks → []", () => {
    const reg = new HookRegistry();
    reg.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] }]);
    expect(reg.hooksFor("turn-end")).toEqual([]);
  });

  test("hooksFor before any rebuild → []", () => {
    expect(new HookRegistry().hooksFor("pre-tool")).toEqual([]);
  });

  test("rebuild replaces the previous index entirely (disable → empty)", () => {
    const reg = new HookRegistry();
    reg.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] }]);
    expect(reg.hooksFor("pre-tool").length).toBe(1);
    reg.rebuild([]); // e.g. the plugin was just disabled
    expect(reg.hooksFor("pre-tool")).toEqual([]);
  });

  test("rebuild with a plugin declaring hooks on multiple events indexes each independently", () => {
    const reg = new HookRegistry();
    reg.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [
        { event: "session-start", command: "./start.sh" },
        { event: "pre-tool", command: "./pre.sh" },
        { event: "post-tool", command: "./post.sh" },
        { event: "turn-end", command: "./end.sh" },
      ] },
    ]);
    expect(reg.hooksFor("session-start")).toEqual([{ pluginId: "alpha", command: "./start.sh", cwd: "/plugins/alpha" }]);
    expect(reg.hooksFor("pre-tool")).toEqual([{ pluginId: "alpha", command: "./pre.sh", cwd: "/plugins/alpha" }]);
    expect(reg.hooksFor("post-tool")).toEqual([{ pluginId: "alpha", command: "./post.sh", cwd: "/plugins/alpha" }]);
    expect(reg.hooksFor("turn-end")).toEqual([{ pluginId: "alpha", command: "./end.sh", cwd: "/plugins/alpha" }]);
  });
});

/** A fake HookRunner (same shape HookFacade depends on) that lets tests control WHEN each run()
 *  resolves and records the order calls arrive in, without spawning real processes. */
class FakeRunner {
  calls: Array<{ spec: HookSpec; payload: HookEventPayload }> = [];
  private queue: Array<{ resolve: (r: HookResult) => void }> = [];
  private results: HookResult[];

  constructor(results: HookResult[]) {
    this.results = [...results];
  }

  run(spec: HookSpec, payload: HookEventPayload): Promise<HookResult> {
    this.calls.push({ spec, payload });
    const result = this.results.shift();
    if (!result) throw new Error("FakeRunner: not enough queued results");
    return Promise.resolve(result);
  }
}

/** A gated fake runner: run() for a given pluginId doesn't resolve until `release(pluginId)` is
 *  called — proves SEQUENTIAL (not parallel) execution, since a `.map()`-style parallel caller
 *  would invoke every run() synchronously regardless of when earlier ones resolve, while a
 *  sequential `for` loop awaiting each call can NEVER reach call N+1 before call N resolves. */
class GatedRunner {
  calls: string[] = [];
  private releasers = new Map<string, () => void>();

  run(spec: HookSpec, _payload: HookEventPayload): Promise<HookResult> {
    this.calls.push(spec.pluginId);
    return new Promise<HookResult>((resolve) => {
      this.releasers.set(spec.pluginId, () => resolve({ status: "ok", stdout: "" }));
    });
  }

  release(pluginId: string): void {
    const r = this.releasers.get(pluginId);
    if (!r) throw new Error(`GatedRunner: no pending call for ${pluginId}`);
    r();
  }
}

function ok(stdout = ""): HookResult { return { status: "ok", stdout }; }
function blocked(reason?: string): HookResult { return { status: "blocked", stdout: "", reason }; }

describe("HookFacade.runFor", () => {
  test("no-hooks fast path: empty registry → runner never called, settings never read", () => {
    const registry = new HookRegistry(); // never rebuilt — no hooks for any event
    const runner = new FakeRunner([]);
    let settingsReads = 0;
    const hooksEnabled = () => { settingsReads++; return true; };
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled });

    return facade.runFor("pre-tool", {}, "sess-1").then((results) => {
      expect(results).toEqual([]);
      expect(runner.calls.length).toBe(0);
      expect(settingsReads).toBe(0); // the empty-registry fast path never touches settings either
    });
  });

  test("hooks.enabled=false with REAL hooks registered → zero runner calls (proves the disable gate, not the empty-registry gate)", async () => {
    const registry = new HookRegistry();
    registry.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] }]);
    const runner = new FakeRunner([ok()]);
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => false });

    const results = await facade.runFor("pre-tool", {}, "sess-1");
    expect(results).toEqual([]);
    expect(runner.calls.length).toBe(0);
  });

  test("hooks.enabled=true with hooks registered → runner IS called (sanity check for the previous two isolation tests)", async () => {
    const registry = new HookRegistry();
    registry.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] }]);
    const runner = new FakeRunner([ok()]);
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const results = await facade.runFor("pre-tool", {}, "sess-1");
    expect(results.length).toBe(1);
    expect(runner.calls.length).toBe(1);
  });

  test("payload shape: {event, sessionId, pluginId, ts, ...extra}", async () => {
    const registry = new HookRegistry();
    registry.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "post-tool", command: "./a.sh" }] }]);
    const runner = new FakeRunner([ok()]);
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const before = Date.now();
    await facade.runFor("post-tool", { toolName: "write", argsJson: "{}" }, "sess-42");
    const after = Date.now();

    expect(runner.calls.length).toBe(1);
    const { payload } = runner.calls[0]!;
    expect(payload.event).toBe("post-tool");
    expect(payload.sessionId).toBe("sess-42");
    expect(payload.pluginId).toBe("alpha");
    expect(payload.toolName).toBe("write");
    expect(payload.argsJson).toBe("{}");
    expect(typeof payload.ts).toBe("number");
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  test("SEQUENTIAL execution proven: call N+1 never starts before call N resolves", async () => {
    const registry = new HookRegistry();
    registry.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "turn-end", command: "./a.sh" }] },
      { id: "beta", dir: "/plugins/beta", hooks: [{ event: "turn-end", command: "./b.sh" }] },
    ]);
    const runner = new GatedRunner();
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const pending = facade.runFor("turn-end", {}, "sess-1");

    // Give the event loop a couple of ticks — a PARALLEL implementation (Promise.all/.map) would
    // have already called run() for BOTH specs by now; a sequential `for`-loop awaiting each call
    // can only ever have called the FIRST one, since alpha's promise is still unresolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.calls).toEqual(["alpha"]);

    runner.release("alpha");
    await Promise.resolve(); // let the sequential loop's await settle and move to beta
    await Promise.resolve();
    expect(runner.calls).toEqual(["alpha", "beta"]);

    runner.release("beta");
    const results = await pending;
    expect(results.map((r) => r.pluginId)).toEqual(["alpha", "beta"]);
  });

  test("pre-tool short-circuits on the first blocked result — later hooks do NOT run", async () => {
    const registry = new HookRegistry();
    registry.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] },
      { id: "beta", dir: "/plugins/beta", hooks: [{ event: "pre-tool", command: "./b.sh" }] },
      { id: "gamma", dir: "/plugins/gamma", hooks: [{ event: "pre-tool", command: "./c.sh" }] },
    ]);
    const runner = new FakeRunner([ok(), blocked("policy says no")]); // gamma's result deliberately unqueued
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const results = await facade.runFor("pre-tool", { toolName: "write" }, "sess-1");

    expect(runner.calls.map((c) => c.spec.pluginId)).toEqual(["alpha", "beta"]); // gamma never invoked
    expect(results.map((r) => r.pluginId)).toEqual(["alpha", "beta"]);
    expect(results[1]!.result).toEqual({ status: "blocked", stdout: "", reason: "policy says no" });
  });

  test("non-pre-tool events do NOT short-circuit on blocked — every hook runs", async () => {
    const registry = new HookRegistry();
    registry.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "post-tool", command: "./a.sh" }] },
      { id: "beta", dir: "/plugins/beta", hooks: [{ event: "post-tool", command: "./b.sh" }] },
    ]);
    const runner = new FakeRunner([blocked("irrelevant for post-tool"), ok()]);
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const results = await facade.runFor("post-tool", {}, "sess-1");

    expect(runner.calls.map((c) => c.spec.pluginId)).toEqual(["alpha", "beta"]); // beta DID run
    expect(results.length).toBe(2);
  });

  test("a non-blocked-status result (error/timeout) on pre-tool does NOT short-circuit", async () => {
    const registry = new HookRegistry();
    registry.rebuild([
      { id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] },
      { id: "beta", dir: "/plugins/beta", hooks: [{ event: "pre-tool", command: "./b.sh" }] },
    ]);
    const runner = new FakeRunner([{ status: "timeout", stdout: "" }, ok()]);
    const facade = new HookFacade({ registry, runner: runner as unknown as HookRunner, hooksEnabled: () => true });

    const results = await facade.runFor("pre-tool", {}, "sess-1");
    expect(runner.calls.map((c) => c.spec.pluginId)).toEqual(["alpha", "beta"]);
    expect(results.length).toBe(2);
  });
});
