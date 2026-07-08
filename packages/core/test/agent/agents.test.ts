import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../src/agent/agents";
import { TrustStore } from "../../src/agent/trust";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ag-"))); }
function writeAgentDef(
  dir: string,
  file: string,
  fm: { name?: string; description?: string; model?: string; tools?: string },
  body: string,
) {
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  if (fm.model !== undefined) lines.push(`model: ${fm.model}`);
  if (fm.tools !== undefined) lines.push(`tools: ${fm.tools}`);
  lines.push("---");
  writeFileSync(join(dir, file), `${lines.join("\n")}\n${body}\n`);
}
function setup() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("AgentStore", () => {
  test("resolve(known) → def instructions (base + body), model, allowTools", () => {
    const { home, trust } = setup();
    writeAgentDef(
      join(home, "agents"),
      "researcher.md",
      { name: "researcher", description: "Researches things", model: "gpt-5.4-mini", tools: "read, grep, glob" },
      "You are a meticulous researcher. RESEARCHER_BODY",
    );
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });
    const r = a.resolve("researcher", null);
    expect(r.instructions).toContain("BASE");
    expect(r.instructions).toContain("RESEARCHER_BODY");
    expect(r.model).toBe("gpt-5.4-mini");
    expect([...r.allowTools!].sort()).toEqual(["glob", "grep", "read"]);
  });

  test("resolve(unknown|undefined) → general-purpose (base + generic overlay, no allowTools/model)", () => {
    const { home, trust } = setup();
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });

    const rUndefined = a.resolve(undefined, null);
    expect(rUndefined.instructions).toContain("BASE");
    expect(rUndefined.instructions).toContain("You are a capable autonomous subagent");
    expect(rUndefined.allowTools).toBeUndefined();
    expect(rUndefined.model).toBeUndefined();

    const rUnknown = a.resolve("no-such-agent", null);
    expect(rUnknown.instructions).toContain("BASE");
    expect(rUnknown.instructions).toContain("You are a capable autonomous subagent");
    expect(rUnknown.allowTools).toBeUndefined();
    expect(rUnknown.model).toBeUndefined();
  });

  test("resolve() with no baseInstructions injected still produces non-empty instructions", () => {
    const { home, trust } = setup();
    const a = new AgentStore({ normaHome: home, trust });
    const r = a.resolve(undefined, null);
    expect(r.instructions.length).toBeGreaterThan(0);
  });

  test("project agent def resolvable only when cwd is trusted (SECURITY)", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    writeAgentDef(
      join(cwd, ".norma", "agents"),
      "reviewer.md",
      { name: "reviewer", description: "Reviews code" },
      "PROJECT_REVIEWER_BODY",
    );
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });

    const untrusted = a.resolve("reviewer", cwd);
    expect(untrusted.instructions).not.toContain("PROJECT_REVIEWER_BODY");
    expect(untrusted.instructions).toContain("You are a capable autonomous subagent"); // falls back to general-purpose

    trust.trust(cwd);
    const trusted = a.resolve("reviewer", cwd);
    expect(trusted.instructions).toContain("PROJECT_REVIEWER_BODY");
  });

  test("name precedence project > user for the same bare name", () => {
    const { home, trust } = setup();
    writeAgentDef(join(home, "agents"), "dup.md", { name: "dup", description: "user version" }, "USER_DUP");
    const cwd = realDir();
    writeAgentDef(join(cwd, ".norma", "agents"), "dup.md", { name: "dup", description: "project version" }, "PROJECT_DUP");
    trust.trust(cwd);
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });
    const r = a.resolve("dup", cwd);
    expect(r.instructions).toContain("PROJECT_DUP");
    expect(r.instructions).not.toContain("USER_DUP");
  });

  test("malformed def skipped (unknown name → general-purpose, no throw)", () => {
    const { home, trust } = setup();
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "broken.md"), "no frontmatter here at all");
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });
    expect(() => a.resolve("broken", null)).not.toThrow();
    const r = a.resolve("broken", null);
    expect(r.instructions).toContain("You are a capable autonomous subagent");
  });

  test("missing agents dir → general-purpose works, no throw", () => {
    const { home, trust } = setup();
    const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });
    expect(() => a.resolve("anything", null)).not.toThrow();
    const r = a.resolve("anything", null);
    expect(r.instructions).toContain("You are a capable autonomous subagent");
    expect(a.list(null)).toEqual([]);
  });

  test("list() reports discovered defs with source", () => {
    const { home, trust } = setup();
    writeAgentDef(join(home, "agents"), "researcher.md", { name: "researcher", description: "Researches things" }, "BODY");
    const cwd = realDir();
    writeAgentDef(join(cwd, ".norma", "agents"), "reviewer.md", { name: "reviewer", description: "Reviews code" }, "BODY2");
    trust.trust(cwd);
    const a = new AgentStore({ normaHome: home, trust });

    const untrusted = a.list(realDir()); // different untrusted cwd
    expect(untrusted.map((d) => d.name)).toEqual(["researcher"]);

    const trusted = a.list(cwd);
    expect(trusted.map((d) => d.name).sort()).toEqual(["researcher", "reviewer"]);
    expect(trusted.find((d) => d.name === "reviewer")!.source).toBe("project");
    expect(trusted.find((d) => d.name === "researcher")!.source).toBe("user");
  });

  // ---------------------------------------------------------------------------------------------
  // Task 4: plugin-contributed agents (design spec §2 — "agents/ dirs feed AgentStore, same
  // pattern as skills"). Namespaced `<plugin>:<agent>`, mirroring SkillStore's plugin namespacing
  // (agent/skills.ts:100). Always live (not gated on settings.plugins.enabled), disabled beats it.
  // ---------------------------------------------------------------------------------------------
  describe("AgentStore + plugin agents (Task 4)", () => {
    test("plugin agent discovered + namespaced <plugin>:<agent> + resolvable", () => {
      const { home, trust } = setup();
      writeAgentDef(
        join(home, "plugins", "demo", "agents"),
        "greet.md",
        { name: "greet", description: "Greets people" },
        "PLUGIN_GREET_BODY",
      );
      const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });

      const listed = a.list(null);
      expect(listed.map((d) => d.name)).toEqual(["demo:greet"]);
      expect(listed[0]!.source).toBe("plugin");

      const r = a.resolve("demo:greet", null);
      expect(r.instructions).toContain("BASE");
      expect(r.instructions).toContain("PLUGIN_GREET_BODY");
    });

    test("disabled plugin's agents absent from list() and unresolvable", () => {
      const { home, trust } = setup();
      writeAgentDef(
        join(home, "plugins", "demo", "agents"),
        "greet.md",
        { name: "greet", description: "Greets people" },
        "PLUGIN_GREET_BODY",
      );
      const a = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE", plugins: { disabled: ["demo"] } });

      expect(a.list(null)).toEqual([]);
      const r = a.resolve("demo:greet", null);
      expect(r.instructions).not.toContain("PLUGIN_GREET_BODY");
      expect(r.instructions).toContain("You are a capable autonomous subagent"); // falls back to general-purpose
    });

    test("multiple non-disabled plugins all contribute; only the disabled one is excluded", () => {
      const { home, trust } = setup();
      writeAgentDef(join(home, "plugins", "a", "agents"), "x.md", { name: "x", description: "d" }, "A_X_BODY");
      writeAgentDef(join(home, "plugins", "b", "agents"), "y.md", { name: "y", description: "d" }, "B_Y_BODY");
      const a = new AgentStore({ normaHome: home, trust, plugins: { disabled: ["b"] } });
      expect(a.list(null).map((d) => d.name)).toEqual(["a:x"]);
    });

    test("precedence project > user > plugin on a namespaced name collision (plugin scanned last)", () => {
      const { home, trust } = setup();
      // A plugin "demo" contributing an agent whose bare name is "dup" namespaces to "demo:dup".
      writeAgentDef(join(home, "plugins", "demo", "agents"), "dup.md", { name: "dup", description: "d" }, "PLUGIN_DUP");
      // The user store directly defines an agent already named "demo:dup" (frontmatter name, not filename-derived).
      writeAgentDef(join(home, "agents"), "userdup.md", { name: "demo:dup", description: "d" }, "USER_DUP");
      const cwd = realDir();
      writeAgentDef(join(cwd, ".norma", "agents"), "projdup.md", { name: "demo:dup", description: "d" }, "PROJECT_DUP");
      trust.trust(cwd);

      // user beats plugin when cwd has no project def at all (untrusted cwd → no project entries).
      const aNoProject = new AgentStore({ normaHome: home, trust, baseInstructions: "BASE" });
      const untrusted = aNoProject.resolve("demo:dup", realDir());
      expect(untrusted.instructions).toContain("USER_DUP");
      expect(untrusted.instructions).not.toContain("PLUGIN_DUP");

      // project beats user (and plugin) once trusted.
      const trusted = aNoProject.resolve("demo:dup", cwd);
      expect(trusted.instructions).toContain("PROJECT_DUP");
      expect(trusted.instructions).not.toContain("USER_DUP");
      expect(trusted.instructions).not.toContain("PLUGIN_DUP");
    });

    test("missing plugins dir → no throw, list() unaffected", () => {
      const { home, trust } = setup();
      writeAgentDef(join(home, "agents"), "researcher.md", { name: "researcher", description: "d" }, "BODY");
      const a = new AgentStore({ normaHome: home, trust });
      expect(() => a.list(null)).not.toThrow();
      expect(a.list(null).map((d) => d.name)).toEqual(["researcher"]);
    });
  });
});
