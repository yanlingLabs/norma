import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerBackgroundTools } from "../../src/agent/tools/background";
import { registerSkillTools } from "../../src/agent/tools/skill";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerTaskTools } from "../../src/agent/tools/tasks";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { registerNotebookTool } from "../../src/agent/tools/notebook";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerRequestDirTool } from "../../src/agent/tools/request-dir";
import { BackgroundTaskRegistry } from "../../src/agent/bg-registry";
import { SkillStore } from "../../src/agent/skills";
import { SessionDirectories } from "../../src/agent/dirs";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { TaskStore } from "../../src/agent/task-store";
import { PlanBroker } from "../../src/agent/plans";
import { AuditLog } from "../../src/peripheral/audit";
import { TrustStore } from "../../src/agent/trust";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

describe("lease-subagent isolation (4h-ii-a prerequisite)", () => {
  test("NO registered agent tool name contains 'lease' or 'peripheral' — peripheral.lease is IPC-only, unreachable from subagent tool specs", () => {
    const registry = new ToolRegistry();
    const tmpDir = mkdtempSync(join(tmpdir(), "lease-isolation-test-"));
    const trustStore = new TrustStore(join(tmpDir, "trust.json"));
    const spawnCtx = () => ({ cwd: "/", roots: ["/"], tmpDir: "/tmp" });

    // Register all standard agent tools (mimics daemon.ts's tool registration in the `if (agentProvider)` block).
    // This is the complete set of tools a subagent can access via its specs().
    registerReadTools(registry);
    registerWriteTools(registry);
    registerBashTool(registry, { bgRegistry: new BackgroundTaskRegistry({ emit: () => {}, spawnCtx }) });
    registerBackgroundTools(registry, { bgRegistry: new BackgroundTaskRegistry({ emit: () => {}, spawnCtx }) }, { deferred: true });
    registerSkillTools(registry, { skills: new SkillStore({ normaHome: tmpDir, trust: trustStore, plugins: { disabled: [] } }) });
    registerToolSearchTool(registry);
    registerAskUserTool(registry);
    registerTaskTools(registry, { tasks: new TaskStore() });
    registerPlanTool(registry, { deferred: true });
    registerNotebookTool(registry, { deferred: true });
    registerWorktreeTools(registry, { deferred: true });
    registerSpawnAgentTool(registry, { models: ["gpt-4"] });
    registerWebTools(registry, { audit: () => {}, secret: async () => null });
    registerRequestDirTool(registry, {
      broker: new ApprovalBroker(),
      dirs: new SessionDirectories(() => []),
      emit: () => {},
      projectDir: () => "/",
    });

    // Get all registered tool names and assert NONE match /lease|peripheral/i
    const allToolNames = registry.specs("/").map((spec) => spec.name);
    const leaseOrPeripheralTools = allToolNames.filter((name) => /lease|peripheral/i.test(name));

    expect(leaseOrPeripheralTools).toEqual([]);
    expect(allToolNames.length).toBeGreaterThan(0); // sanity: we actually registered tools

    // Double-check: verify some expected tools ARE registered (sanity test)
    expect(allToolNames).toContain("read");
    expect(allToolNames).toContain("write");
    expect(allToolNames).toContain("bash");
    expect(allToolNames).toContain("spawn_agent");
  });

  test("specs() for a subagent (no exclusions) contains no lease-related tools", () => {
    const registry = new ToolRegistry();
    const tmpDir = mkdtempSync(join(tmpdir(), "lease-isolation-test2-"));
    const spawnCtx = () => ({ cwd: "/", roots: ["/"], tmpDir: "/tmp" });

    // Register a minimal set
    registerReadTools(registry);
    registerBashTool(registry, { bgRegistry: new BackgroundTaskRegistry({ emit: () => {}, spawnCtx }) });

    // A subagent's specs() is the SAME call a child thread in engine.ts line 566 makes:
    // registry.specs(cwd, opts with deferThreshold, loaded, etc.)
    // but filtered by excludeTools/allowTools. Since there's no lease tool to exclude,
    // we verify it was never there in the first place.
    const childSpecs = registry.specs("/");
    const names = childSpecs.map((s) => s.name);

    // Assert no lease or peripheral tool exists
    for (const name of names) {
      expect(name).not.toMatch(/lease|peripheral/i);
    }
  });
});
