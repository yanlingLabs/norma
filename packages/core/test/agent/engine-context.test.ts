import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

describe("engine uses assembled context", () => {
  test("a turn's instructions include a TRUSTED project NORMA.md + base prompt", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-home-")));
    const trust = new TrustStore(join(home, "trust.json"));
    // build an engine whose session cwd has a NORMA.md, and trust it:
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-cwd-")));
    writeFileSync(join(cwd, "NORMA.md"), "PROJECT_SENTINEL_XYZ");
    trust.trust(cwd);
    const assembler = new ContextAssembler({ normaHome: home, trust });
    const provider = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, sessionId } = setupEngine(provider, { cwd, assembler }); // harness threads the assembler + cwd
    await engine.runTurn(sessionId);
    const instr = provider.requests[0]!.instructions;
    expect(instr).toContain("PROJECT_SENTINEL_XYZ");
    expect(instr).toContain("Norma"); // base prompt
  });

  test("an UNtrusted project NORMA.md is NOT in the instructions", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-h2-")));
    const trust = new TrustStore(join(home, "trust.json"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-c2-")));
    writeFileSync(join(cwd, "NORMA.md"), "UNTRUSTED_SENTINEL");
    const assembler = new ContextAssembler({ normaHome: home, trust }); // cwd NOT trusted
    const provider = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    const { engine, sessionId } = setupEngine(provider, { cwd, assembler });
    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.instructions).not.toContain("UNTRUSTED_SENTINEL");
  });
});
