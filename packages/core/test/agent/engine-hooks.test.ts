import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { PermissionGate, type GateDecision, type SessionApprovalPolicy } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { AgentStore } from "../../src/agent/agents";
import { SubagentManager } from "../../src/agent/subagents";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";
import type { HookResult } from "../../src/plugins/hook-runner";
import type { ProviderEvent } from "../../src/providers/types";

// ---- Fake cfg.hooks facade (NO processes) ---------------------------------------------------
// Records every runFor(event, extra, sessionId) call and returns a scripted per-event verdict.
type HookOutcome = { pluginId: string; result: HookResult };
type Responder = (event: string, extra: Record<string, unknown>) => HookOutcome[];

class FakeHooks {
  readonly calls: Array<{ event: string; extra: Record<string, unknown>; sessionId: string }> = [];
  constructor(private readonly resp: Responder) {}
  async runFor(event: string, extra: Record<string, unknown>, sessionId: string): Promise<HookOutcome[]> {
    this.calls.push({ event, extra, sessionId });
    return this.resp(event, extra);
  }
  count(event: string): number { return this.calls.filter((c) => c.event === event).length; }
  countTool(event: string, toolName: string): number {
    return this.calls.filter((c) => c.event === event && c.extra.toolName === toolName).length;
  }
  ofEvent(event: string) { return this.calls.filter((c) => c.event === event); }
}

// "probe" is unclassified → the real gate returns "ask" even under `auto` (fail-closed). Allow it
// so a probe call reaches Site 2 + executeCall without an approval prompt.
class AllowProbeGate extends PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
    if (toolName === "probe") return "allow";
    return super.evaluate(toolName, policy);
  }
}

function setup(
  script: ProviderEvent[][],
  opts: { hooks?: FakeHooks; approvalPolicy?: "ask" | "auto" | "plan" } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-hooks-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-hooks-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerSpawnAgentTool(registry);
  const probe = { runs: 0, lastArgs: undefined as unknown };
  registry.register({
    name: "probe",
    description: "test probe tool",
    args: z.object({ note: z.string().optional() }),
    run: async (args) => { probe.runs++; probe.lastArgs = args; return "probe-output"; },
  });
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-hooks-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const agentsHome = mkdtempSync(join(tmpdir(), "norma-engine-hooks-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager({});
  const bgAgents = new BackgroundAgentRegistry();
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new AllowProbeGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    agents,
    subagents,
    bgAgents,
    hooks: opts.hooks,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, sessionId, cwd, provider, events, probe };
}

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const probeCall = (callId: string): ProviderEvent => ({ type: "tool_call", callId, name: "probe", argsJson: JSON.stringify({ note: "hi" }) });
const spawnCall = (callId: string, prompt: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "test task" }) });

const ok = (stdout = ""): HookOutcome[] => [{ pluginId: "ctx", result: { status: "ok", stdout } }];
const blocked = (pluginId: string, reason?: string): HookOutcome[] => [{ pluginId, result: { status: "blocked", reason, stdout: "" } }];

function toolResult(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined {
  return events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;
}

describe("AgentEngine: plugin hook points (4f Task 3)", () => {
  // (a) pre-tool block → registered tool's run NOT called + exact isError tool_result wording.
  test("(a) pre-tool block → tool NOT executed, typed isError tool_result (exact wording)", async () => {
    const hooks = new FakeHooks((event) => (event === "pre-tool" ? blocked("guard", "nope") : []));
    const { engine, store, sessionId, probe } = setup([
      [probeCall("p1"), done("tool_calls")],
      text("noted the block"),
    ], { hooks });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(probe.runs).toBe(0); // the tool never ran
    const r = toolResult(events, "p1");
    expect(r).toMatchObject({ isError: true, output: "blocked by plugin hook guard: nope" });
    // (also covers j for a NORMAL call): post-tool never fired for the blocked probe
    expect(hooks.countTool("post-tool", "probe")).toBe(0);
  });

  // (b) pre-tool ok → tool runs; and the hook WAS consulted (fails pre-impl).
  test("(b) pre-tool ok → tool runs normally, pre-tool was consulted", async () => {
    const hooks = new FakeHooks(() => []);
    const { engine, store, sessionId, probe } = setup([
      [probeCall("p1"), done("tool_calls")],
      text("done"),
    ], { hooks });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(hooks.countTool("pre-tool", "probe")).toBe(1);
    expect(probe.runs).toBe(1);
    expect(toolResult(events, "p1")).toMatchObject({ isError: false, output: "probe-output" });
  });

  // (c) pre-tool blocks a spawn_agent (bridge path) → NO thread_started + isError tool_result.
  test("(c) pre-tool blocks spawn_agent → no thread_started, typed isError tool_result", async () => {
    const hooks = new FakeHooks((event, extra) =>
      (event === "pre-tool" && extra.toolName === "spawn_agent" ? blocked("guard", "no spawning") : []));
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("parent wrapped up"),
    ], { hooks });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(toolResult(events, "s1")).toMatchObject({ isError: true, output: "blocked by plugin hook guard: no spawning" });
  });

  // (d) session-start stdout → system-reminder in FIRST turn's input, ABSENT in the second turn's.
  test("(d) session-start stdout → system-reminder in first turn only, once per session", async () => {
    const hooks = new FakeHooks((event) => (event === "session-start" ? ok("INJECTED CONTEXT") : []));
    const { engine, sessionId, provider } = setup([text("hi"), text("hi again")], { hooks });
    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);

    const injected = (input: unknown[]) =>
      input.some((i) => typeof (i as { content?: unknown }).content === "string"
        && ((i as { content: string }).content.includes("INJECTED CONTEXT"))
        && ((i as { content: string }).content.includes("<system-reminder>")));

    expect(injected(provider.requests[0]!.input)).toBe(true); // first turn
    expect(injected(provider.requests[1]!.input)).toBe(false); // second turn — fired once per session
    expect(hooks.count("session-start")).toBe(1);
  });

  // (e) post-tool receives {toolName, output, isError} for a normal call.
  test("(e) post-tool observes a normal call's outcome (toolName/output/isError)", async () => {
    const hooks = new FakeHooks(() => []);
    const { engine, sessionId } = setup([
      [probeCall("p1"), done("tool_calls")],
      text("done"),
    ], { hooks });
    await engine.runTurn(sessionId);

    const post = hooks.ofEvent("post-tool");
    expect(post.length).toBe(1);
    expect(post[0]!.extra).toMatchObject({ toolName: "probe", output: "probe-output", isError: false, threadId: "main" });
    expect(typeof post[0]!.extra.argsJson).toBe("string");
  });

  // (f) turn-end fires once per MAIN turn, zero for child threads.
  test("(f) turn-end fires once for the MAIN turn, not for child threads", async () => {
    const hooks = new FakeHooks(() => []);
    const { engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child done"),
      text("parent done"),
    ], { hooks });
    await engine.runTurn(sessionId);

    expect(hooks.count("turn-end")).toBe(1);
    const te = hooks.ofEvent("turn-end")[0]!;
    expect(te.extra).toMatchObject({ stopReason: "end_turn" });
    expect(typeof te.extra.inputTokens).toBe("number");
    expect(typeof te.extra.outputTokens).toBe("number");
  });

  // (g) hook error/timeout results → tool proceeds (fail-open) + nothing injected.
  test("(g) error/timeout results are fail-open: tool proceeds, nothing injected", async () => {
    const hooks = new FakeHooks((event) => {
      if (event === "session-start") return [{ pluginId: "p", result: { status: "timeout", stdout: "SHOULD NOT INJECT" } }];
      if (event === "pre-tool") return [{ pluginId: "p", result: { status: "error", stdout: "" } }];
      return [];
    });
    const { engine, sessionId, provider, probe } = setup([
      [probeCall("p1"), done("tool_calls")],
      text("done"),
    ], { hooks });
    await engine.runTurn(sessionId);

    expect(probe.runs).toBe(1); // pre-tool error did NOT block
    const injectedAnywhere = provider.requests.some((req) =>
      req.input.some((i) => typeof (i as { content?: unknown }).content === "string"
        && (i as { content: string }).content.includes("SHOULD NOT INJECT")));
    expect(injectedAnywhere).toBe(false); // session-start timeout injected nothing
  });

  // (h) cfg.hooks absent → the facade is never called; the engine runs unchanged.
  test("(h) cfg.hooks absent → facade never called, tool runs normally", async () => {
    const notWired = new FakeHooks(() => blocked("guard", "should never fire"));
    const { engine, store, sessionId, probe } = setup([
      [probeCall("p1"), done("tool_calls")],
      text("done"),
    ]); // no hooks passed
    await engine.runTurn(sessionId);

    expect(notWired.calls.length).toBe(0);
    expect(probe.runs).toBe(1);
    expect(toolResult(store.read(sessionId), "p1")).toMatchObject({ isError: false });
  });

  // (i) no-double-fire: a spawn_agent call fires pre-tool exactly ONCE.
  test("(i) no-double-fire: spawn_agent fires pre-tool exactly once", async () => {
    const hooks = new FakeHooks(() => []);
    const { engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child done"),
      text("parent done"),
    ], { hooks });
    await engine.runTurn(sessionId);

    expect(hooks.countTool("pre-tool", "spawn_agent")).toBe(1);
  });

  // (j) post-tool NOT fired for a pre-tool-blocked (bridged) call.
  test("(j) post-tool NOT fired for a pre-tool-blocked spawn_agent call", async () => {
    const hooks = new FakeHooks((event, extra) =>
      (event === "pre-tool" && extra.toolName === "spawn_agent" ? blocked("guard", "no") : []));
    const { engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("parent wrapped up"),
    ], { hooks });
    await engine.runTurn(sessionId);

    expect(hooks.countTool("pre-tool", "spawn_agent")).toBe(1); // pre-tool DID fire
    expect(hooks.countTool("post-tool", "spawn_agent")).toBe(0); // but post-tool did NOT
  });
});
