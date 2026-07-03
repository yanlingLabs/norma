import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-sk-"))); }
function writeSkill(root: string, dir: string, name: string, desc: string, body: string) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
}
function setup() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("SkillStore", () => {
  test("user + self skills always listed; project skill listed ONLY when trusted (SECURITY)", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "skills"), "greet", "greet", "Say hi", "Say hello warmly.");
    writeSkill(join(home, "skills", "self"), "note", "note", "Take notes", "Write notes.");
    const cwd = realDir();
    writeSkill(join(cwd, ".norma", "skills"), "proj", "proj-skill", "Project thing", "PROJECT_BODY");
    const s = new SkillStore({ normaHome: home, trust });

    const untrusted = s.list({ cwd });
    expect(untrusted.map((m) => m.name).sort()).toEqual(["greet", "note"]); // no project skill
    expect(s.load("proj-skill", { cwd })).toBeNull();                       // untrusted → not loadable

    trust.trust(cwd);
    const trusted = s.list({ cwd });
    expect(trusted.map((m) => m.name).sort()).toEqual(["greet", "note", "proj-skill"]);
    expect(s.load("proj-skill", { cwd })!.body).toContain("PROJECT_BODY");
    expect(trusted.find((m) => m.name === "proj-skill")!.source).toBe("project");
  });

  test("plugin skills are namespaced <plugin>:<skill>", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "plugins", "cool", "skills"), "doit", "doit", "Do it", "Do the thing.");
    const s = new SkillStore({ normaHome: home, trust });
    const m = s.list({ cwd: null });
    expect(m.map((x) => x.name)).toContain("cool:doit");
    expect(m.find((x) => x.name === "cool:doit")!.source).toBe("plugin");
    expect(s.load("cool:doit", { cwd: null })!.body).toContain("Do the thing");
  });

  test("name precedence project > user for the same bare name", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "skills"), "dup", "dup", "user version", "USER_DUP");
    const cwd = realDir();
    writeSkill(join(cwd, ".norma", "skills"), "dup", "dup", "project version", "PROJECT_DUP");
    trust.trust(cwd);
    const s = new SkillStore({ normaHome: home, trust });
    const dup = s.list({ cwd }).filter((m) => m.name === "dup");
    expect(dup.length).toBe(1);
    expect(dup[0]!.source).toBe("project");
    expect(s.load("dup", { cwd })!.body).toContain("PROJECT_DUP");
  });

  test("body cap + frontmatter stripped", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "skills"), "big", "big", "big skill", "x".repeat(40000));
    const s = new SkillStore({ normaHome: home, trust, caps: { bodyBytes: 32768 } });
    const body = s.load("big", { cwd: null })!.body;
    expect(body).not.toContain("---"); // frontmatter stripped
    expect(body).toContain("[…truncated]");
    expect(Buffer.byteLength(body.replace("\n[…truncated]", ""), "utf8")).toBeLessThanOrEqual(32768 + 8);
  });

  test("malformed / no-name / directory-SKILL.md skills are skipped, never throw", () => {
    const { home, trust } = setup();
    mkdirSync(join(home, "skills", "nofm", "SKILL.md"), { recursive: true }); // a DIRECTORY named SKILL.md
    mkdirSync(join(home, "skills", "noname"), { recursive: true });
    writeFileSync(join(home, "skills", "noname", "SKILL.md"), "no frontmatter here"); // no name/description
    writeSkill(join(home, "skills"), "ok", "ok", "fine", "OK_BODY");
    const s = new SkillStore({ normaHome: home, trust });
    expect(() => s.list({ cwd: null })).not.toThrow();
    expect(s.list({ cwd: null }).map((m) => m.name)).toEqual(["ok"]); // only the valid one
    expect(s.load("noname", { cwd: null })).toBeNull();
  });

  test("empty / missing dirs → empty list, no throw", () => {
    const { home, trust } = setup();
    const s = new SkillStore({ normaHome: home, trust });
    expect(s.list({ cwd: null })).toEqual([]);
    expect(s.load("nope", { cwd: null })).toBeNull();
  });

  test("a disabled plugin's skills are not discovered; others unaffected", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "plugins", "on", "skills"), "hi", "hi", "Say hi", "Hi there!");
    writeSkill(join(home, "plugins", "off", "skills"), "bye", "bye", "Say bye", "Goodbye!");

    const store = new SkillStore({ normaHome: home, trust, plugins: { disabled: ["off"] } });
    const names = store.list({ cwd: null }).map((s) => s.name);

    expect(names).toContain("on:hi");
    expect(names).not.toContain("off:bye");
  });

  test("without disabled plugins dep, all plugin skills are discovered (unchanged behavior)", () => {
    const { home, trust } = setup();
    writeSkill(join(home, "plugins", "on", "skills"), "hi", "hi", "Say hi", "Hi there!");
    writeSkill(join(home, "plugins", "off", "skills"), "bye", "bye", "Say bye", "Goodbye!");

    const store = new SkillStore({ normaHome: home, trust });
    const names = store.list({ cwd: null }).map((s) => s.name);

    expect(names).toContain("on:hi");
    expect(names).toContain("off:bye");
  });
});
