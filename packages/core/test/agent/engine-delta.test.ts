import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

function setup(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-delta-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-delta-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-delta-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry,
    broker: new ApprovalBroker(),
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  const live: SessionEvent[] = [];
  hub.attach({ clientName: "observer", deliver: (e) => { live.push(e); return true; } }, sessionId, 0);
  return { engine, store, sessionId, live };
}

describe("assistant_delta streaming", () => {
  test("each text_delta broadcasts an assistant_delta before the final assistant_message", async () => {
    const { engine, sessionId, live } = setup([[
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
      { type: "usage", inputTokens: 10, outputTokens: 2 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await engine.runTurn(sessionId);
    const deltas = live.filter((e) => e.type === "assistant_delta");
    expect(deltas.map((d) => (d as { delta: string }).delta)).toEqual(["hel", "lo"]);
    expect(deltas.every((d) => (d as { threadId: string }).threadId === "main")).toBe(true);
    // deltas arrive strictly before the assistant_message in the live stream
    const iMsg = live.findIndex((e) => e.type === "assistant_message");
    const iLastDelta = live.map((e) => e.type).lastIndexOf("assistant_delta");
    expect(iLastDelta).toBeLessThan(iMsg);
  });

  test("deltas are transient: absent from the persisted log and from replay", async () => {
    const { engine, store, sessionId } = setup([[
      { type: "text_delta", delta: "hi" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e) => e.type === "assistant_delta")).toBe(false);
  });

  test("delta seq never exceeds the next persisted event's seq (monotonic-safe for naive trackers)", async () => {
    const { engine, sessionId, live } = setup([[
      { type: "text_delta", delta: "x" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await engine.runTurn(sessionId);
    let watermark = 0;
    for (const e of live) {
      // a delta is stamped with the store's lastSeq at broadcast time — never ahead of persistence
      if (e.type === "assistant_delta") expect(e.seq).toBeLessThanOrEqual(watermark);
      else { expect(e.seq).toBeGreaterThan(watermark); watermark = e.seq; }
    }
  });

  test("empty text_delta chunks are not broadcast", async () => {
    const { engine, sessionId, live } = setup([[
      { type: "text_delta", delta: "" },
      { type: "text_delta", delta: "ok" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await engine.runTurn(sessionId);
    const deltas = live.filter((e) => e.type === "assistant_delta");
    expect(deltas.map((d) => (d as { delta: string }).delta)).toEqual(["ok"]);
  });
});
