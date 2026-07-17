import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSessionSpawnTool } from "../../src/agent/tools/session-spawn";
import { DispatchChildren } from "../../src/agent/dispatch-children";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ModelInfo, ProviderEvent } from "../../src/providers/types";

// Dispatch (Phase 7) Task 4: the session_spawn engine bridge. `setup()` wires ONE AgentEngine +
// ONE FakeProvider shared by BOTH the dispatch session's own turn AND any child session's
// fire-and-forget turn `DispatchChildren.spawnChild` kicks off — so every script used in this
// file keeps a SAFE, order-independent tail entry (a plain text + end_turn response) that any
// caller (dispatch's own round 1, or the child's round 0) can consume regardless of exact
// microtask interleaving between the two independent async chains. Only round 0 (consumed
// synchronously, first, by the explicit `engine.runTurn(dispatchSessionId)` call below, before
// anything else ever touches the provider) is order-sensitive, and that ordering is guaranteed by
// test structure, not timing.
function setup(
  script: ProviderEvent[][],
  opts: { mode?: "code" | "dispatch"; withDispatchRegistry?: boolean; models?: ModelInfo[] } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-session-spawn-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-spawn-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerSessionSpawnTool(registry, { models: ["fake-1"] });
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script, opts.models);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-session-spawn-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  let dispatchChildren: DispatchChildren | undefined;
  const engine: AgentEngine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    dispatch: () => dispatchChildren,
  });
  if (opts.withDispatchRegistry !== false) {
    dispatchChildren = new DispatchChildren({
      store, hub,
      runTurn: (sid) => engine.runTurn(sid),
      isRunning: (sid) => engine.isRunning(sid),
    });
  }
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, sessionId, provider, cwd, events, registry };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];
// The SAFE tail round every script below ends with — order-independent (see setup()'s own comment).
const finish: ProviderEvent[] = text("ok");
const spawnCall = (args: Record<string, unknown>): ProviderEvent[] => [
  { type: "tool_call", callId: "c1", name: "session_spawn", argsJson: JSON.stringify(args) },
  done("tool_calls"),
];

describe("session_spawn tool spec", () => {
  test("registered with the dispatch-visible schema", () => {
    const { registry } = setup([finish]);
    const spec = registry.specs(null).find((s) => s.name === "session_spawn");
    expect(spec).toBeDefined();
  });
});

describe("engine bridge: session_spawn in a dispatch session", () => {
  test("valid spawn: creates a first-class child code session, appends its opening transcript, posts a child_update, and returns the child id in the tool_result", async () => {
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-spawn-child-")));
    const { engine, store, sessionId, events } = setup(
      [spawnCall({ dir: childDir, prompt: "fix the bug", title: "Fix bug" }), finish],
      { mode: "dispatch" },
    );
    await engine.runTurn(sessionId);

    const childUpdate = events.find((e) => e.type === "child_update");
    expect(childUpdate).toBeDefined();
    expect(childUpdate).toMatchObject({ status: "running", title: "Fix bug" });
    const childId = (childUpdate as { childSessionId: string }).childSessionId;
    expect(typeof childId).toBe("string");
    expect(childId.length).toBeGreaterThan(0);

    // New child session: mode "code", origin "dispatch-child", parentSessionId = dispatch id, cwd, auto policy.
    const meta = store.meta(childId);
    expect(meta.mode).toBe("code");
    expect(meta.origin).toBe("dispatch-child");
    expect(meta.parentSessionId).toBe(sessionId);
    expect(meta.cwd).toBe(childDir);
    expect(meta.approvalPolicy).toBe("auto");

    // Child stream starts with session_created then a user_message, clientName "dispatch".
    const childEvents = store.read(childId, 0);
    expect(childEvents[0]?.type).toBe("session_created");
    const firstUserMessage = childEvents.find((e) => e.type === "user_message");
    expect(firstUserMessage).toBeDefined();
    expect((firstUserMessage as { text: string }).text).toBe("fix the bug");
    expect((firstUserMessage as { clientName: string }).clientName).toBe("dispatch");

    // The tool_result on the DISPATCH stream carries the child sessionId.
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError: boolean }).isError).toBe(false);
    expect((toolResult as { output: string }).output).toContain(childId);
  });

  test("relative dir → isError tool_result mentioning 'absolute', no session created", async () => {
    const { engine, store, sessionId, events } = setup(
      [spawnCall({ dir: "relative/path", prompt: "do work" }), finish],
      { mode: "dispatch" },
    );
    const before = store.list().length;
    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError: boolean }).isError).toBe(true);
    expect((toolResult as { output: string }).output).toContain("absolute");
    expect(events.find((e) => e.type === "child_update")).toBeUndefined();
    expect(store.list().length).toBe(before); // no child session created
  });

  test("type:'cowork' → isError 'not yet available', no session created", async () => {
    const { engine, store, sessionId, events } = setup(
      [spawnCall({ dir: "/tmp/some-dir", prompt: "do work", type: "cowork" }), finish],
      { mode: "dispatch" },
    );
    const before = store.list().length;
    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError: boolean }).isError).toBe(true);
    expect((toolResult as { output: string }).output).toContain("not yet available");
    expect(store.list().length).toBe(before);
  });

  test("unknown model → isError listing available ids, no session created", async () => {
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-spawn-child2-")));
    const { engine, store, sessionId, events } = setup(
      [spawnCall({ dir: childDir, prompt: "do work", model: "nonexistent-model" }), finish],
      { mode: "dispatch" }, // FakeProvider's default models() is non-empty: [{id:"fake-1",...}]
    );
    const before = store.list().length;
    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError: boolean }).isError).toBe(true);
    expect((toolResult as { output: string }).output).toContain("unknown model");
    expect((toolResult as { output: string }).output).toContain("fake-1");
    expect(store.list().length).toBe(before);
  });

  test("empty prompt → isError, no session created", async () => {
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-spawn-child3-")));
    const { engine, store, sessionId, events } = setup(
      [[{ type: "tool_call", callId: "c1", name: "session_spawn", argsJson: JSON.stringify({ dir: childDir, prompt: "" }) }, done("tool_calls")], finish],
      { mode: "dispatch" },
    );
    const before = store.list().length;
    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError: boolean }).isError).toBe(true);
    expect(store.list().length).toBe(before);
  });
});

describe("session_spawn tool visibility", () => {
  test("dispatch session: session_spawn IS visible in the provider's tool list", async () => {
    const { engine, sessionId, provider } = setup([finish], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));
    expect(names.has("session_spawn")).toBe(true);
  });

  test("code session: session_spawn is NOT visible in the provider's tool list (already covered by Task 3's flipped test; cheap regression here too)", async () => {
    const { engine, sessionId, provider } = setup([finish], { mode: "code" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));
    expect(names.has("session_spawn")).toBe(false);
  });
});
