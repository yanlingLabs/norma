import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { registerSkillTools } from "../../../src/agent/tools/skill";
import { SkillStore } from "../../../src/agent/skills";
import { TrustStore } from "../../../src/agent/trust";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1", ...over };
}

describe("Skill tool", () => {
  test("loads the body + marks the skill loaded; unknown name → isError, not marked", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-skt-")));
    mkdirSync(join(home, "skills", "haiku"), { recursive: true });
    writeFileSync(join(home, "skills", "haiku", "SKILL.md"), "---\nname: haiku\ndescription: d\n---\nHAIKU_INSTRUCTIONS\n");
    const skills = new SkillStore({ normaHome: home, trust: new TrustStore(join(home, "trust.json")) });
    const r = new ToolRegistry();
    registerSkillTools(r, { skills });
    const marked: string[] = [];
    const ok = await r.execute("Skill", { name: "haiku" }, ctx({ markSkillLoaded: (n) => marked.push(n) }));
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain("HAIKU_INSTRUCTIONS");
    expect(marked).toEqual(["haiku"]);
    // F1 (4e gate ledger): tool RESULT carries a trailing continue-nudge so the model doesn't
    // stop the turn right after announcing a freshly loaded skill.
    expect(ok.output.endsWith(
      "[Skill loaded. Do not stop after announcing it: continue in this same turn by taking the skill's first concrete step (if that step is asking the user something, ask it now).]",
    )).toBe(true);

    const bad = await r.execute("Skill", { name: "ghost" }, ctx({ markSkillLoaded: (n) => marked.push(n) }));
    expect(bad.isError).toBe(true);
    expect(marked).toEqual(["haiku"]); // ghost NOT marked
  });
});
