import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ctx-"))); }
function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("ContextAssembler", () => {
  test("user NORMA.md always loads; project NORMA.md loads only when trusted (SECURITY)", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "NORMA.md"), "USER_RULE_SENTINEL");
    const cwd = realDir();
    writeFileSync(join(cwd, "NORMA.md"), "PROJECT_RULE_SENTINEL");
    const a = new ContextAssembler({ normaHome: home, trust });

    const untrusted = a.assemble({ cwd });
    expect(untrusted).toContain("USER_RULE_SENTINEL");
    expect(untrusted).not.toContain("PROJECT_RULE_SENTINEL"); // untrusted project NORMA.md is NOT injected

    trust.trust(cwd);
    const trusted = a.assemble({ cwd });
    expect(trusted).toContain("PROJECT_RULE_SENTINEL");        // trusted → injected
    expect(trusted).toContain("USER_RULE_SENTINEL");
  });

  test("base prompt present; capability stub present; empty sources omit their headers", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ normaHome: home, trust });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("Norma"); // base prompt
    expect(out).toMatch(/Available capabilities/);
    expect(out).not.toMatch(/Project instructions/); // no cwd → no project header
    expect(out).not.toMatch(/User instructions/);     // no user NORMA.md → no header
  });

  test("memory index: user always, project trusted-only", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "memory", "MEMORY.md"), "USER_MEMORY_FACT");
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "memory", "MEMORY.md"), "PROJECT_MEMORY_FACT");
    const a = new ContextAssembler({ normaHome: home, trust });
    const untrusted = a.assemble({ cwd });
    expect(untrusted).toContain("USER_MEMORY_FACT");
    expect(untrusted).not.toContain("PROJECT_MEMORY_FACT");
    trust.trust(cwd);
    expect(a.assemble({ cwd })).toContain("PROJECT_MEMORY_FACT");
  });

  test("caps: oversized NORMA.md truncated with marker; long MEMORY.md line-capped", () => {
    const { home, trust } = setup();
    writeFileSync(join(home, "NORMA.md"), "x".repeat(40000));
    writeFileSync(join(home, "memory", "MEMORY.md"), Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n"));
    const a = new ContextAssembler({ normaHome: home, trust });
    const out = a.assemble({ cwd: null });
    expect(out).toContain("[…truncated]");
    expect(out).not.toContain("line300"); // beyond the 200-line memory cap
    expect(out).toContain("line0");
  });

  test("missing/broken files never throw (section omitted)", () => {
    const { home, trust } = setup();
    const a = new ContextAssembler({ normaHome: home, trust });
    // point cwd at a dir with a NORMA.md that is actually a directory (unreadable as a file)
    const cwd = realDir(); mkdirSync(join(cwd, "NORMA.md")); trust.trust(cwd);
    expect(() => a.assemble({ cwd })).not.toThrow();
    expect(a.assemble({ cwd })).not.toContain("Project instructions");
  });
});
