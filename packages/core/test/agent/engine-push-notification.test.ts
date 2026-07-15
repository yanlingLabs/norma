import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
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
  const home = mkdtempSync(join(tmpdir(), "norma-engine-push-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-push-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerPushNotificationTool(registry);
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-push-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const fallbackCalls: Array<{ title: string; message: string }> = [];
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    notifyFallback: (title, message) => { fallbackCalls.push({ title, message }); },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, hub, sessionId, fallbackCalls };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe("AgentEngine: push_notification bridge", () => {
  test("emits notification_requested (persisted, thread-scoped) with the tool's title/message", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "push_notification", argsJson: JSON.stringify({ message: "done", title: "Build" }) }, done("tool_calls")],
      text("ok"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const notified = events.find((e) => e.type === "notification_requested");
    expect(notified).toMatchObject({ threadId: "main", title: "Build", message: "done" });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false, output: "notification sent" });
  });

  test("nobody attached at call time → osascript fallback fires", async () => {
    const { engine, sessionId, fallbackCalls } = setup([
      [{ type: "tool_call", callId: "c1", name: "push_notification", argsJson: JSON.stringify({ message: "headless run finished" }) }, done("tool_calls")],
      text("ok"),
    ]);
    await engine.runTurn(sessionId);
    expect(fallbackCalls).toEqual([{ title: "Norma", message: "headless run finished" }]);
  });

  test("a harness IS attached at call time → osascript fallback does NOT fire", async () => {
    const { engine, hub, sessionId, fallbackCalls } = setup([
      [{ type: "tool_call", callId: "c1", name: "push_notification", argsJson: JSON.stringify({ message: "watched run finished" }) }, done("tool_calls")],
      text("ok"),
    ]);
    const watcher: HubClient = { clientName: "cli-chat", deliver: () => true };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    expect(fallbackCalls).toEqual([]);
  });

  test("the SAME call always emits the event regardless of attachment — only the fallback is conditional", async () => {
    const { engine, hub, store, sessionId, fallbackCalls } = setup([
      [{ type: "tool_call", callId: "c1", name: "push_notification", argsJson: JSON.stringify({ message: "still logged" }) }, done("tool_calls")],
      text("ok"),
    ]);
    const watcher: HubClient = { clientName: "cli-chat", deliver: () => true };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    expect(fallbackCalls).toEqual([]); // attached — no fallback
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "notification_requested" && e.message === "still logged")).toBe(true); // still persisted
  });
});
