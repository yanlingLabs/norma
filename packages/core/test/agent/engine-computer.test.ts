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
import type { ModelInfo, ProviderEvent } from "../../src/providers/types";

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
    computerUse,
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
});
