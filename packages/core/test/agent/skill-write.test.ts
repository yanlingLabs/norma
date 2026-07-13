import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSkillWriteTool } from "../../src/agent/tools/skill-write";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setup } from "./engine-spawn.test";

// Phase 5c Task 2: skill_write — the agent-facing surface over T1's SkillStore.writeSelf. PLAIN
// TOOL (memory.ts / memory-tools.test.ts is the model): behavior is testable directly against the
// tool + store; the engine is only needed for the child-exclusion E2E at the bottom. The gate
// posture (ALWAYS_ASK: card under BOTH ask and auto) is pinned in gate.test.ts, not here.

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-skw-")));
}

function setupTool() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  const skills = new SkillStore({ normaHome: home, trust });
  const r = new ToolRegistry();
  registerSkillWriteTool(r, { skills });
  return { home, skills, r };
}

const ctx = (sessionId: string) => ({ cwd: "/tmp", roots: ["/tmp"], sessionId });

describe("skill_write tool (phase 5c Task 2)", () => {
  test("registry round-trip: file lands under skills/self, author stamped by the STORE, listed as source 'self' and loadable", async () => {
    const { home, skills, r } = setupTool();
    const out = await r.execute("skill_write", { name: "release-notes", description: "Draft release notes", body: "BODY_TEXT" }, ctx("s1"));
    expect(out.isError).toBe(false);
    const raw = readFileSync(join(home, "skills", "self", "release-notes", "SKILL.md"), "utf8");
    expect(raw).toContain("author: norma"); // the store's stamp, not caller-supplied
    const metas = skills.list({ cwd: null }).filter((m) => m.name === "release-notes");
    expect(metas).toHaveLength(1);
    expect(metas[0]!.source).toBe("self");
    expect(skills.load("release-notes", { cwd: null })!.body).toContain("BODY_TEXT");
  });

  test("slug jail: traversal name → typed isError, verbatim from the store, fs untouched", async () => {
    const { home, r } = setupTool();
    const out = await r.execute("skill_write", { name: "../evil", description: "d", body: "b" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: 'invalid skill name "../evil"' });
    expect(existsSync(join(home, "skills", "self"))).toBe(false); // rejected BEFORE any fs op
  });

  test("whitespace-only description (passes zod min(1)) → store's non-empty-description error, verbatim", async () => {
    const { r } = setupTool();
    const out = await r.execute("skill_write", { name: "x", description: " \n ", body: "b" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: 'skill "x" needs a non-empty description' });
  });

  test("missing required args → zod invalid-arguments typed error", async () => {
    const { r } = setupTool();
    const out = await r.execute("skill_write", { name: "a" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for skill_write");
  });

  test("not registered (deps absent) → the registry's unknown-tool error, same as any sibling", async () => {
    const r = new ToolRegistry();
    const out = await r.execute("skill_write", { name: "a", description: "d", body: "b" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "unknown tool: skill_write" });
  });
});

// -------------------------------------------------------------------------------------------
// Engine E2E: child-tool-set exclusion — mirrors agent-query.test.ts's 5a exclusion test.
// -------------------------------------------------------------------------------------------
const done = (reason: "end_turn" | "tool_calls" | "aborted") => ({ type: "done" as const, stopReason: reason });
const text = (t: string) => [{ type: "text_delta" as const, delta: t }, done("end_turn")];
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};

describe("AgentEngine: skill_write child exclusion E2E (phase 5c Task 2)", () => {
  test("skill_write is excluded from a depth-1 child's tool set (consent laundering), present in the main thread's", async () => {
    // run_in_background:false — the subject is tool-set filtering, not the bg default; the child
    // must run synchronously so its provider request is deterministically recorded (same shape as
    // the 5a agent_list/agent_output exclusion test).
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", run_in_background: false }) }, done("tool_calls")],
      text("child done"),
      text("parent done"),
    ]);
    const { engine, sessionId, registry } = setup([], { provider });
    const home = realDir();
    registerSkillWriteTool(registry, { skills: new SkillStore({ normaHome: home, trust: new TrustStore(join(home, "trust.json")) }) });

    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    const childReq = fp.requests.find((r) => isChildRun(r.input, "child-task"));
    expect(childReq).toBeDefined();
    const childTools = (childReq!.tools ?? []).map((t) => t.name);
    expect(childTools).not.toContain("skill_write");
    expect(childTools).toContain("read"); // sanity: filter is real, not an empty tool set

    const mainReq = fp.requests.find((r) => !isChildRun(r.input, "child-task"));
    const mainTools = (mainReq!.tools ?? []).map((t) => t.name);
    expect(mainTools).toContain("skill_write");
  });
});
