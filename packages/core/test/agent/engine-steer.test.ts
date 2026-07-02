import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { GatedProvider, deferred } from "../../src/agent/test-providers";
import type { Provider } from "../../src/providers/types";

// Mirrors packages/core/test/agent/engine.test.ts's setup().
function setupEngine(provider: Provider) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-steer-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-steer-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "gated-1" },
    dirs,
    approvalTimeoutMs: 500,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, hub, broker, sessionId, cwd, dirs };
}

describe("engine steering", () => {
  test("a message steered during a running turn is injected into the next round's input", async () => {
    // round 0: a tool call (gated so we can steer while it's in flight), then done:tool_calls.
    // round 1: end the turn.
    const gate = deferred();
    const provider = new GatedProvider(
      [
        [{ type: "tool_call", callId: "t1", name: "read", argsJson: JSON.stringify({ path: "MISSING.txt" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ],
      [gate.promise, null], // round 0 blocks on the gate
    );
    const { engine, sessionId } = setupEngine(provider); // harness builds the engine with this provider
    const turn = engine.runTurn(sessionId);              // do NOT await yet
    await new Promise((r) => setTimeout(r, 20));          // let round 0 enter streamTurn (gated)
    expect(engine.isRunning(sessionId)).toBe(true);
    const res = engine.steer(sessionId, "ACTUALLY DO X");  // running → queued
    expect(res.injected).toBe(true);
    gate.resolve();                                        // release round 0
    await turn;
    // round 1's input must contain the steered user message:
    const round1 = provider.requests[1]!;
    expect(round1.inputSnapshot.some((it) => it.type === "message" && it.role === "user" && it.content === "ACTUALLY DO X")).toBe(true);
  });

  test("steer with no running turn starts a turn (message reaches the model)", async () => {
    const provider = new GatedProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, sessionId } = setupEngine(provider);
    const res = engine.steer(sessionId, "hello");
    expect(res.injected).toBe(false);
    await new Promise((r) => setTimeout(r, 30)); // let the started turn run
    expect(provider.requests[0]!.inputSnapshot.some((it) => it.type === "message" && it.content === "hello")).toBe(true);
  });

  test("finishing-turn race: a steer that lands as the model ends continues the turn", async () => {
    // round 0 ends the turn immediately, but a steer is queued before the completion check via a gate on round 0.
    const gate = deferred();
    const provider = new GatedProvider(
      [[{ type: "done", stopReason: "end_turn" }], [{ type: "text_delta", delta: "did X" }, { type: "done", stopReason: "end_turn" }]],
      [gate.promise, null],
    );
    const { engine, sessionId } = setupEngine(provider);
    const turn = engine.runTurn(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    engine.steer(sessionId, "one more thing"); // queued while round 0 is gated
    gate.resolve();
    await turn;
    // the turn did a SECOND round (didn't complete after round 0) → provider saw 2 requests, round 1 has the steer:
    expect(provider.requests.length).toBe(2);
    expect(provider.requests[1]!.inputSnapshot.some((it) => it.type === "message" && it.content === "one more thing")).toBe(true);
  });
});
