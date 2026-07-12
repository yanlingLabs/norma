import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerAgentQueryTools } from "../../src/agent/tools/agent-query";
import { BackgroundAgentRegistry, type ResumeContext } from "../../src/agent/bg-agent-registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setup } from "./engine-spawn.test";

// Phase 5a Task 1: agent_list + agent_output — read-only collection tools over
// BackgroundAgentRegistry (list your subagents / fetch what they've said), the counterpart to
// spawn_agent/send_message/task_stop's write/control surface. Both are PLAIN TOOLS like task_stop
// (task-stop.test.ts is the model): most behavior is testable directly against the tool +
// registries, with the engine only needed for child-tool-set exclusion and the per-round pin.

const done = (reason: "end_turn" | "tool_calls" | "aborted") => ({ type: "done" as const, stopReason: reason });
const text = (t: string) => [{ type: "text_delta" as const, delta: t }, done("end_turn")];
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};

const ctx = (sessionId: string) => ({ cwd: "/tmp", roots: ["/tmp"], sessionId });

// Minimal ResumeContext fixture — only `description` varies across tests; the rest is filler that
// satisfies the interface's required fields (agent_list/agent_output never read them).
const resumeCtx = (description?: string): ResumeContext => ({
  cwd: "/tmp", approvalPolicy: "auto", instructions: "x", openingPrompt: "x", depth: 0, loaded: [], excludeTools: [], description,
});

describe("agent_list (phase 5a Task 1)", () => {
  test("empty session → literal 'no background agents in this session', no footer", async () => {
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents: new BackgroundAgentRegistry(), store: { read: () => [] } });

    const out = await r.execute("agent_list", {}, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "no background agents in this session" });
  });

  test("two entries (named+running with description, unnamed+terminal without description) → one line each + footer", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_a", sessionId: "s1", threadId: "th_a", name: "worker", abort: new AbortController(), resume: resumeCtx("do the thing") });
    bgAgents.get("th_a")!.startedAt = Date.now() - 5000; // pin elapsed to a stable 5s

    bgAgents.register({ agentId: "th_b", sessionId: "s1", threadId: "th_b", abort: new AbortController() });
    bgAgents.complete("th_b", { ok: true, result: "done result" });
    bgAgents.get("th_b")!.startedAt = Date.now() - 9000; // pin elapsed to a stable 9s

    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => [] } });

    const out = await r.execute("agent_list", {}, ctx("s1"));
    expect(out.isError).toBe(false);
    expect(out.output.split("\n")).toEqual([
      "th_a (worker) — running, elapsed 5s — do the thing",
      "th_b — completed, elapsed 9s",
      "Message or re-task an agent with send_message; fetch results with agent_output; stop with task_stop.",
    ]);
  });

  test("is session-scoped: an entry in a DIFFERENT session is not listed", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_foreign", sessionId: "s2", threadId: "th_foreign", abort: new AbortController() });
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => [] } });

    const out = await r.execute("agent_list", {}, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "no background agents in this session" });
  });
});

describe("agent_output (phase 5a Task 1)", () => {
  test("unknown agent → typed isError", async () => {
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents: new BackgroundAgentRegistry(), store: { read: () => [] } });

    const out = await r.execute("agent_output", { agent: "ghost" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "no such agent 'ghost' in this session — agent_list shows them" });
  });

  test("missing agent arg → invalid-args typed error (zod)", async () => {
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents: new BackgroundAgentRegistry(), store: { read: () => [] } });

    const out = await r.execute("agent_output", {}, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for agent_output");
  });

  test("terminal (completed) agent → returns the recorded result; `notified` (already true) is LEFT true, never mutated", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_done", sessionId: "s1", threadId: "th_done", abort: new AbortController() });
    bgAgents.complete("th_done", { ok: true, result: "the answer is 42" }, { notified: true });
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => [] } });

    const out = await r.execute("agent_output", { agent: "th_done" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_done' completed\nthe answer is 42" });
    expect(bgAgents.get("th_done", "s1")?.notified).toBe(true); // unchanged
  });

  test("terminal (failed) agent with no result recorded → the '(no result recorded)' fallback; `notified` (false) stays false", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_fail", sessionId: "s1", threadId: "th_fail", abort: new AbortController() });
    bgAgents.complete("th_fail", { ok: false, result: "" });
    bgAgents.get("th_fail")!.result = undefined; // force the missing-result branch
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => [] } });

    const out = await r.execute("agent_output", { agent: "th_fail" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_fail' failed\n(no result recorded)" });
    expect(bgAgents.get("th_fail", "s1")?.notified).toBe(false); // agent_output never claims notification
  });

  test("running agent with an assistant_message in the store → returns the LAST one for its threadId", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_run", sessionId: "s1", threadId: "th_run", abort: new AbortController() });
    bgAgents.get("th_run")!.startedAt = Date.now() - 7000;

    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s1", ts: Date.now(), type: "assistant_message", threadId: "th_run", text: "first update" },
      { seq: 2, sessionId: "s1", ts: Date.now(), type: "assistant_message", threadId: "other", text: "unrelated thread" },
      { seq: 3, sessionId: "s1", ts: Date.now(), type: "assistant_message", threadId: "th_run", text: "second update" },
    ];
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => events } });

    const out = await r.execute("agent_output", { agent: "th_run" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_run' running (7s elapsed)\nlatest: second update" });
  });

  test("running agent with no assistant_message for its threadId → 'no output yet'", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    bgAgents.register({ agentId: "th_run2", sessionId: "s1", threadId: "th_run2", abort: new AbortController() });
    bgAgents.get("th_run2")!.startedAt = Date.now() - 2000;
    const r = new ToolRegistry();
    registerAgentQueryTools(r, { bgAgents, store: { read: () => [] } });

    const out = await r.execute("agent_output", { agent: "th_run2" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_run2' running (2s elapsed)\nno output yet" });
  });
});

// -------------------------------------------------------------------------------------------
// Engine E2E tests: child-tool-set exclusion (depth-0-only addressing) and the per-round pin.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: agent_list/agent_output E2E (phase 5a Task 1)", () => {
  test("both tools are excluded from a depth-1 child's tool set (v1 depth-0 only, same rationale as send_message/task_stop)", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task" }) }, done("tool_calls")],
      text("child done"),
      text("parent done"),
    ]);
    const { engine, sessionId, bgAgents, registry, store } = setup([], { provider });
    registerAgentQueryTools(registry, { bgAgents, store });

    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    const childReq = fp.requests.find((r) => isChildRun(r.input, "child-task"));
    expect(childReq).toBeDefined();
    const childTools = (childReq!.tools ?? []).map((t) => t.name);
    expect(childTools).not.toContain("agent_list");
    expect(childTools).not.toContain("agent_output");
    expect(childTools).toContain("read"); // sanity: filter is real, not an empty tool set

    const mainReq = fp.requests.find((r) => !isChildRun(r.input, "child-task"));
    const mainTools = (mainReq!.tools ?? []).map((t) => t.name);
    expect(mainTools).toContain("agent_list");
    expect(mainTools).toContain("agent_output");
  });

  test("(pin) agent_list + agent_output are pinned into specs whenever ANY bg agent entry exists — including a TERMINAL one, unlike task_stop's running-only pin", async () => {
    const provider = new FakeProvider([text("turn1 ok"), text("turn2 ok")]);
    const { engine, sessionId, bgAgents, registry, store } = setup([], { provider, toolSearch: { deferThreshold: 12 } });
    registerAgentQueryTools(registry, { bgAgents, store });

    await engine.runTurn(sessionId); // turn 1: no entries yet — both stay deferred/hidden
    const fp = provider as FakeProvider;
    const turn1Names = fp.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(turn1Names).not.toContain("agent_list");
    expect(turn1Names).not.toContain("agent_output");

    const abort = new AbortController();
    bgAgents.register({ agentId: "th_pin1", sessionId, threadId: "th_pin1", abort });
    bgAgents.stop("th_pin1"); // now terminal — list(sessionId).length is still > 0

    await engine.runTurn(sessionId); // turn 2
    const turn2Names = fp.requests[1]!.tools?.map((t) => t.name) ?? [];
    expect(turn2Names).toContain("agent_list");
    expect(turn2Names).toContain("agent_output");
  });
});
