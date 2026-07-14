import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerComputerTool } from "../../src/agent/tools/computer";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { ComputerUseService, type PeripheralBrokerLike, type CuScheduler } from "../../src/agent/computer-use";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";

class FakeBroker implements PeripheralBrokerLike {
  releaseCalls = 0;
  callPayloads: string[] = [];
  callResult: any = { ok: true, resultJson: JSON.stringify({ dataUrl: "data:image/png;base64,ABC", width: 1512, height: 982, scaledWidth: 1280, scaledHeight: 831 }) };
  async lease() { return { leaseId: "l1", token: "t1", expiresAt: 1_000_000_000_000 }; }
  renew() { return { ok: true as const, expiresAt: 1_000_000_000_000 }; }
  release() { this.releaseCalls++; return { ok: true as const }; }
  async call(req: { payloadJson: string }) { this.callPayloads.push(req.payloadJson); return this.callResult; }
}

const noTimer: CuScheduler = { setInterval: () => 0, clearInterval: () => {} };

function setup(script: ProviderEvent[][], vision: boolean, broker = new FakeBroker()) {
  const home = mkdtempSync(join(tmpdir(), "norma-cu-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cu-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerComputerTool(registry);
  const approval = new ApprovalBroker();
  const models: ModelInfo[] = [{ id: "m", family: "fake", contextWindow: 100_000, supportsVision: vision }];
  const provider = new FakeProvider(script, models);
  const dirs = new SessionDirectories(() => [cwd]);
  const aHome = mkdtempSync(join(tmpdir(), "norma-cu-actx-"));
  const aTrust = new TrustStore(join(aHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: aHome, trust: aTrust, skills: new SkillStore({ normaHome: aHome, trust: aTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "m" }, store, hub });
  const computerUse = new ComputerUseService({ broker, scheduler: noTimer });
  const engine = new AgentEngine({
    store, hub, registry, broker: approval,
    gate: new PermissionGate(),
    provider: { provider, model: "m" },
    dirs, assembler, compactor,
    // hot-settings T5a: EngineConfig.computerUse is now a getter (`() => ComputerUseService |
    // undefined`) — this wraps the plain instance built above, unchanged behavior (always resolves
    // to the same `computerUse`, exactly like the pre-getter field).
    computerUse: () => computerUse,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, sessionId, provider, broker };
}

const usage: ProviderEvent = { type: "usage", inputTokens: 5, outputTokens: 1 };
function screenshotRound(): ProviderEvent[] {
  return [{ type: "tool_call", callId: "c1", name: "computer", argsJson: '{"action":"screenshot"}' }, usage, { type: "done", stopReason: "tool_calls" }];
}
function endRound(): ProviderEvent[] {
  return [{ type: "text_delta", delta: "done" }, usage, { type: "done", stopReason: "end_turn" }];
}

describe("engine computer-use integration", () => {
  test("a screenshot tool_call stages an image into the NEXT round's provider input", async () => {
    const { engine, store, sessionId, provider } = setup([screenshotRound(), endRound()], true);
    await engine.runTurn(sessionId);

    // The second provider call's input must carry the staged screenshot as an {type:"image"} item.
    expect(provider.requests.length).toBe(2);
    const round2Input = provider.requests[1]!.input;
    const imageItem = round2Input.find((i) => i.type === "image");
    expect(imageItem).toBeDefined();
    expect(imageItem).toEqual({ type: "image", imageUrl: "data:image/png;base64,ABC" });

    // The image comes AFTER the tool_result (batch intact, image trailing as a user turn).
    const trIdx = round2Input.findIndex((i) => i.type === "tool_result");
    const imgIdx = round2Input.findIndex((i) => i.type === "image");
    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(imgIdx).toBeGreaterThan(trIdx);

    // The persisted tool_result is the TEXT describing the screenshot — the image is NOT persisted.
    const toolResult = store.read(sessionId).find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false });
    expect((toolResult as any).output).toContain("Screenshot captured");
    expect((toolResult as any).output).not.toContain("base64"); // no image bytes in the log
  });

  test("releaseSession fires when the turn settles (leases released)", async () => {
    const { engine, sessionId, broker } = setup([screenshotRound(), endRound()], true);
    await engine.runTurn(sessionId);
    expect(broker.releaseCalls).toBeGreaterThanOrEqual(1);
  });

  test("screenshot on a NON-vision model is refused (isError, no image, no lease call)", async () => {
    const broker = new FakeBroker();
    const { engine, store, sessionId, provider } = setup([screenshotRound(), endRound()], false, broker);
    await engine.runTurn(sessionId);
    const toolResult = store.read(sessionId).find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as any).output).toContain("vision-capable");
    // never reached the peripheral
    expect(broker.callPayloads.length).toBe(0);
    // no image staged into the next round
    expect(provider.requests[1]!.input.some((i) => i.type === "image")).toBe(false);
  });

  test("no image staged for a non-screenshot computer action", async () => {
    const broker = new FakeBroker();
    broker.callResult = { ok: true, resultJson: JSON.stringify({ text: "#0 window\n#1 button 'Save'" }) };
    const axRound: ProviderEvent[] = [{ type: "tool_call", callId: "c1", name: "computer", argsJson: '{"action":"ax_snapshot"}' }, usage, { type: "done", stopReason: "tool_calls" }];
    const { engine, store, sessionId, provider } = setup([axRound, endRound()], true, broker);
    await engine.runTurn(sessionId);
    expect(provider.requests[1]!.input.some((i) => i.type === "image")).toBe(false);
    const toolResult = store.read(sessionId).find((e) => e.type === "tool_result");
    expect((toolResult as any).output).toContain("button 'Save'");
  });

  test("EngineConfig.computerUse getter is read LIVE, not captured at construction — flipping the closed-over value changes what a LATER turn's tool ctx sees", async () => {
    // hot-settings T5a: the whole point of the getter conversion. `svc` stands in for daemon.ts's
    // (T5b's) mutable settings-backed holder — the engine must re-read it every turn, not freeze
    // whatever it resolved to at construction time.
    const broker = new FakeBroker();
    broker.callResult = { ok: true, resultJson: JSON.stringify({ text: "#0 window" }) };
    let svc: ComputerUseService | undefined; // starts undefined — CU boot-disabled

    const home = mkdtempSync(join(tmpdir(), "norma-cu-live-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cu-live-cwd-")));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const registry = new ToolRegistry();
    registerComputerTool(registry);
    const approval = new ApprovalBroker();
    const models: ModelInfo[] = [{ id: "m", family: "fake", contextWindow: 100_000, supportsVision: true }];
    const axRound = (): ProviderEvent[] => [{ type: "tool_call", callId: "c1", name: "computer", argsJson: '{"action":"ax_snapshot"}' }, usage, { type: "done", stopReason: "tool_calls" }];
    const provider = new FakeProvider([axRound(), endRound(), axRound(), endRound(), axRound(), endRound()], models);
    const dirs = new SessionDirectories(() => [cwd]);
    const aHome = mkdtempSync(join(tmpdir(), "norma-cu-live-actx-"));
    const aTrust = new TrustStore(join(aHome, "trust.json"));
    const assembler = new ContextAssembler({ normaHome: aHome, trust: aTrust, skills: new SkillStore({ normaHome: aHome, trust: aTrust }) });
    const compactor = new Compactor({ provider: { provider, model: "m" }, store, hub });
    const engine = new AgentEngine({
      store, hub, registry, broker: approval,
      gate: new PermissionGate(),
      provider: { provider, model: "m" },
      dirs, assembler, compactor,
      computerUse: () => svc, // reads the mutable `svc` LIVE on every call, not a snapshot
    });
    const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });

    // Turn 1: svc is undefined → the computer tool sees ctx.computerUse === undefined → errors.
    await engine.runTurn(sessionId);
    let results = store.read(sessionId).filter((e) => e.type === "tool_result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0] as any).output).toContain("not available");

    // Flip the closed-over value to a live service — no engine reconstruction.
    svc = new ComputerUseService({ broker, scheduler: noTimer });

    // Turn 2 (same engine instance, same getter): now resolves to the real service.
    await engine.runTurn(sessionId);
    results = store.read(sessionId).filter((e) => e.type === "tool_result");
    expect(results.length).toBe(2);
    expect(results[1]).toMatchObject({ isError: false });
    expect((results[1] as any).output).toContain("window");

    // Flip back to undefined — a later turn must see the disable too (not a one-way sticky read).
    svc = undefined;
    await engine.runTurn(sessionId);
    results = store.read(sessionId).filter((e) => e.type === "tool_result");
    expect(results.length).toBe(3);
    expect(results[2]).toMatchObject({ isError: true });
    expect((results[2] as any).output).toContain("not available");
  });

  test("hot-settings T5b: a CU hot-ENABLE mid-turn still gets its lease released in runTurn's finally", async () => {
    // Regression for the T5a finding: runTurn used to snapshot `this.cfg.computerUse?.()` ONCE at
    // turn start, before `turn()` runs. If CU was disabled at turn start (svc undefined) but a
    // settings-watcher apply hot-enabled it MID-turn (svc reassigned to a live service), a later
    // tool_call in the SAME turn could acquire a lease against that live service — but the
    // finally's stale `undefined` snapshot would skip releaseSession entirely, leaking the lease
    // until the service's own 60s maxIdleMs backstop. T5b moved the read to be LIVE, inside the
    // finally, so it resolves to whatever service actually holds the turn's lease.
    const broker = new FakeBroker();
    broker.callResult = { ok: true, resultJson: JSON.stringify({ text: "#0 window" }) };
    let svc: ComputerUseService | undefined; // starts undefined — CU boot-disabled, like daemon.ts pre-enable

    const home = mkdtempSync(join(tmpdir(), "norma-cu-midturn-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cu-midturn-cwd-")));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const registry = new ToolRegistry();
    registerComputerTool(registry);
    const approval = new ApprovalBroker();
    const models: ModelInfo[] = [{ id: "m", family: "fake", contextWindow: 100_000, supportsVision: true }];
    const axRound: ProviderEvent[] = [{ type: "tool_call", callId: "c1", name: "computer", argsJson: '{"action":"ax_snapshot"}' }, usage, { type: "done", stopReason: "tool_calls" }];
    // A settings-watcher apply landing MID-TURN has no natural tool-call trigger to drive from a
    // scripted FakeProvider — a real settings.json edit is an async fs event, not something a
    // tool_call can simulate. Flipping `svc` from the PROVIDER's own round boundary (synchronously,
    // BEFORE the generator yields that round's events) models exactly that: by the time runTurn's
    // synchronous pre-`turn()` snapshot (the OLD T5a code) would have already run, `svc` is still
    // undefined — the flip only happens once the SECOND streamTurn call is reached, which is
    // strictly inside `turn()`'s round loop, i.e. genuinely mid-turn.
    class FlippingProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private call = 0;
      models(): ModelInfo[] { return models; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        if (this.call === 1) svc = new ComputerUseService({ broker, scheduler: noTimer }); // fires before round index 1's events are yielded
        const script = [endRound(), axRound, endRound()];
        const events = script[Math.min(this.call++, script.length - 1)] ?? [];
        for (const e of events) yield e;
      }
    }
    const provider = new FlippingProvider();
    const dirs = new SessionDirectories(() => [cwd]);
    const aHome = mkdtempSync(join(tmpdir(), "norma-cu-midturn-actx-"));
    const aTrust = new TrustStore(join(aHome, "trust.json"));
    const assembler = new ContextAssembler({ normaHome: aHome, trust: aTrust, skills: new SkillStore({ normaHome: aHome, trust: aTrust }) });
    const compactor = new Compactor({ provider: { provider, model: "m" }, store, hub });
    const engine = new AgentEngine({
      store, hub, registry, broker: approval,
      gate: new PermissionGate(),
      provider: { provider, model: "m" },
      dirs, assembler, compactor,
      computerUse: () => svc, // reads the mutable `svc` LIVE — same shape as daemon.ts's holder
    });
    const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });

    // Turn 1: ends immediately (round 0 = endRound()) — CU still disabled (svc undefined).
    await engine.runTurn(sessionId);
    expect(svc).toBeUndefined();

    // Turn 2: round 1 (call index 1) flips `svc` on BEFORE its events are yielded, then the model
    // uses `computer` in that SAME round — one runTurn call, CU hot-enabled strictly mid-turn.
    await engine.runTurn(sessionId);

    const results = store.read(sessionId).filter((e) => e.type === "tool_result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ isError: false, output: expect.stringContaining("window") }); // ax_snapshot succeeded live

    // The lease acquired mid-turn on the now-live `svc` must be released by runTurn's finally —
    // NOT left dangling for the 60s idle backstop.
    expect(svc).toBeDefined();
    expect(svc!.holdsAny(sessionId)).toBe(false);
    expect(broker.releaseCalls).toBeGreaterThanOrEqual(1);
  });
});
