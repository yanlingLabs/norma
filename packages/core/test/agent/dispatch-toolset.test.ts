import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerComputerTool } from "../../src/agent/tools/computer";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { registerNotebookTool } from "../../src/agent/tools/notebook";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { registerSkillWriteTool } from "../../src/agent/tools/skill-write";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { LspManager } from "../../src/agent/lsp/manager";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler, BASE_PROMPT } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { DISPATCH_ALLOW_TOOLS } from "../../src/agent/dispatch-prompt";
import type { ProviderEvent } from "../../src/providers/types";

// Full-surface registry: every tool a code session sees, INCLUDING the six that must never be
// dispatch-visible (write, edit, notebook_edit, spawn_agent, skill_write, lsp) — so the "does NOT
// include" assertions below are actually exercising the allowTools filter, not a vacuous absence.
function setup(script: ProviderEvent[][], opts: { mode?: "code" | "dispatch" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerComputerTool(registry);
  registerBashTool(registry);
  registerTaskStopTool(registry);
  registerNotebookTool(registry);
  registerSpawnAgentTool(registry);
  registerPushNotificationTool(registry);
  registerAskUserTool(registry);
  registerWebTools(registry);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-toolset-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  registerSkillWriteTool(registry, { skills });
  const lsp = new LspManager({ serverCommands: {} });
  registerLspTools(registry, { lsp, cwdOf: () => cwd, rootsOf: () => [cwd] });

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: opts.mode });
  return { engine, store, sessionId, provider, cwd };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe("dispatch mode: toolset + system prompt", () => {
  test("dispatch session: provider-visible tools are a subset of DISPATCH_ALLOW_TOOLS, include session_spawn-eligible names, exclude write/edit/lsp/spawn_agent/skill_write/notebook_edit", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));

    for (const n of names) expect(DISPATCH_ALLOW_TOOLS.has(n)).toBe(true);
    expect(names.has("bash")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    // session_spawn isn't registered yet (Task 4) — it's whitelisted but absent from this registry.
    expect(names.has("session_spawn")).toBe(false);

    for (const excluded of ["write", "edit", "lsp", "spawn_agent", "skill_write", "notebook_edit"]) {
      expect(names.has(excluded)).toBe(false);
    }
  });

  test("code session: same registry sees write/edit unchanged (regression)", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code" });
    await engine.runTurn(sessionId);
    const names = new Set((provider.requests[0]?.tools ?? []).map((t) => t.name));

    for (const expected of ["write", "edit", "lsp", "spawn_agent", "skill_write", "notebook_edit", "bash", "read"]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("dispatch turn's instructions carry Dispatch-mode doctrine and NOT the code base prompt's file-paths sentence", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "dispatch" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Dispatch mode");
    expect(instructions).not.toContain("file tool paths are relative to it");
    expect(BASE_PROMPT).toContain("file tool paths are relative to it"); // sanity: the sentence we assert absent is real
  });

  test("code turn's instructions still carry the code base prompt (regression)", async () => {
    const { engine, sessionId, provider } = setup([text("ok")], { mode: "code" });
    await engine.runTurn(sessionId);
    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("file tool paths are relative to it");
    expect(instructions).not.toContain("Dispatch mode");
  });
});
