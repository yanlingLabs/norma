import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerTaskTools } from "../../src/agent/tools/tasks";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { TaskStore } from "../../src/agent/task-store";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

function setup(script: ProviderEvent[][], opts: { questions?: boolean; tasks?: boolean } = {}) {
  const withQuestions = opts.questions !== false;
  const withTasks = opts.tasks !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-askt-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-askt-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerAskUserTool(registry);
  const questions = withQuestions ? new QuestionBroker() : undefined;
  const tasks = withTasks ? new TaskStore() : undefined;
  if (tasks) registerTaskTools(registry, { tasks });
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-askt-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    questions,
    tasks,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, hub, broker, questions, tasks, sessionId, cwd, provider };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

const askArgs = {
  questions: [{
    question: "Pick one", header: "Pick",
    options: [{ label: "A" }, { label: "B" }],
    multiSelect: false,
  }],
};

describe("AgentEngine: ask_user / task bridges", () => {
  test("ask_user: question_asked emitted (wait registered first), respond → question_resolved + answers in the result", async () => {
    const { engine, store, hub, questions, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "ask_user", argsJson: JSON.stringify(askArgs) }, done("tool_calls")],
      text("thanks"),
    ]);
    // Watcher answers as soon as it observes question_asked — only works if QuestionBroker.wait()
    // was registered BEFORE the emit (the ordering property under test, same as approvals).
    const watcher: HubClient = {
      clientName: "answerer",
      deliver(e) {
        if (e.type === "question_asked") questions!.respond(sessionId, e.callId, { "Pick one": "B" }, "test");
        return true;
      },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const asked = events.find((e) => e.type === "question_asked");
    const resolved = events.find((e) => e.type === "question_resolved");
    expect(asked).toMatchObject({ callId: "c1", questions: askArgs.questions });
    expect(resolved).toMatchObject({ callId: "c1", answers: { "Pick one": "B" }, by: "test" });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false });
    expect((toolResult as any).output).toContain("Pick: B");
  });

  test("ask_user timeout → proceed message (short NORMA_ASK_TIMEOUT_MS)", async () => {
    const prev = process.env.NORMA_ASK_TIMEOUT_MS;
    process.env.NORMA_ASK_TIMEOUT_MS = "50";
    try {
      const { engine, store, sessionId } = setup([
        [{ type: "tool_call", callId: "c1", name: "ask_user", argsJson: JSON.stringify(askArgs) }, done("tool_calls")],
        text("ok"),
      ]);
      // No watcher — the question is left unanswered and must time out via the broker itself.
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.some((e) => e.type === "question_asked")).toBe(true);
      const resolved = events.find((e) => e.type === "question_resolved");
      expect(resolved).toMatchObject({ by: "timeout" });
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toMatchObject({ isError: false });
      expect((toolResult as any).output).toContain("Proceed with your best judgment");
    } finally {
      if (prev === undefined) delete process.env.NORMA_ASK_TIMEOUT_MS;
      else process.env.NORMA_ASK_TIMEOUT_MS = prev;
    }
  });

  test("task_create in a turn → task_updated persisted + broadcast", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "t1", name: "task_create", argsJson: JSON.stringify({ subject: "Ship it" }) }, done("tool_calls")],
      text("created"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const updated = events.find((e) => e.type === "task_updated");
    expect(updated).toMatchObject({ task: { id: "1", subject: "Ship it", status: "pending" } });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false });
  });

  test("no questions config → ask_user degrades to the proceed message (no question_asked/resolved)", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "ask_user", argsJson: JSON.stringify(askArgs) }, done("tool_calls")],
      text("ok"),
    ], { questions: false });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "question_asked")).toBe(false);
    expect(events.some((e) => e.type === "question_resolved")).toBe(false);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false });
    expect((toolResult as any).output).toContain("Proceed with your best judgment");
  });
});
