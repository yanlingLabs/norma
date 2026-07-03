import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore } from "../../src/agent/plugins";

function home(): string { return mkdtempSync(join(tmpdir(), "norma-plugins-")); }
function plugin(h: string, name: string, opts: { manifest?: unknown; skills?: string[]; mcp?: boolean } = {}) {
  const dir = join(h, "plugins", name); mkdirSync(dir, { recursive: true });
  if (opts.manifest !== undefined) writeFileSync(join(dir, "plugin.json"), typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest));
  for (const s of opts.skills ?? []) { mkdirSync(join(dir, "skills", s), { recursive: true }); writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: d\n---\nbody`); }
  if (opts.mcp) writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
  return dir;
}

describe("PluginStore", () => {
  test("missing plugins dir → []", () => { expect(new PluginStore({ normaHome: home() }).list()).toEqual([]); });
  test("manifest parsed; dir name canonical; skills + hasMcp listed", () => {
    const h = home(); plugin(h, "demo", { manifest: { name: "other-name", version: "0.1.0", description: "d" }, skills: ["greet", "bye"], mcp: true });
    const [p] = new PluginStore({ normaHome: h }).list();
    if (!p) throw new Error("expected one plugin");
    expect(p.name).toBe("demo");                 // DIR NAME canonical, not manifest.name
    expect(p.version).toBe("0.1.0");
    expect(p.skills.sort()).toEqual(["bye", "greet"]);
    expect(p.hasMcp).toBe(true);
    expect(p.mcpEnabled).toBe(false); expect(p.disabled).toBe(false);
  });
  test("manifest-less + malformed-manifest plugins still load", () => {
    const h = home(); plugin(h, "bare", { skills: ["s1"] }); plugin(h, "broken", { manifest: "{not json", skills: ["s2"] });
    const names = new PluginStore({ normaHome: h }).list().map((p) => p.name).sort();
    expect(names).toEqual(["bare", "broken"]);
  });
  test("mcpEnabled/disabled from settings; disabled beats enabled", () => {
    const h = home(); plugin(h, "a", { mcp: true }); plugin(h, "b", { mcp: true });
    const l = new PluginStore({ normaHome: h, plugins: { enabled: ["a", "b"], disabled: ["b"] } }).list();
    expect(l.find((p) => p.name === "a")!.mcpEnabled).toBe(true);
    const b = l.find((p) => p.name === "b")!;
    expect(b.disabled).toBe(true); expect(b.mcpEnabled).toBe(false);
  });
});
