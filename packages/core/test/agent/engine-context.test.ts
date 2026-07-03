import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { FakeProvider } from "../../src/agent/fake-provider";
import { GatedProvider, deferred } from "../../src/agent/test-providers";
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

  test("a mid-turn NORMA.md change is NOT reflected in the same turn (context assembled once per turn)", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-home2-")));
    const trust = new TrustStore(join(home, "trust.json"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-ec-cwd2-")));
    writeFileSync(join(cwd, "NORMA.md"), "ORIGINAL_RULE");
    trust.trust(cwd);
    const assembler = new ContextAssembler({ normaHome: home, trust });

    // round 0: a tool call (gated so we can mutate NORMA.md while it's in flight), then tool_calls stop.
    // round 1: end the turn. Two provider rounds total.
    const gate = deferred();
    const provider = new GatedProvider(
      [
        [{ type: "tool_call", callId: "t1", name: "read", argsJson: JSON.stringify({ path: "MISSING.txt" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ],
      [gate.promise, null],
    );
    const { engine, sessionId } = setupEngine(provider, { cwd, assembler });

    const turn = engine.runTurn(sessionId); // do NOT await yet
    await new Promise((r) => setTimeout(r, 20)); // let round 0 enter streamTurn (gated)
    expect(engine.isRunning(sessionId)).toBe(true);

    // mutate NORMA.md mid-turn, while round 0 is still gated:
    writeFileSync(join(cwd, "NORMA.md"), "CHANGED_MIDTURN");
    gate.resolve(); // release round 0 → round 1 runs
    await turn;

    expect(provider.requests.length).toBe(2);
    expect(provider.requests[0]!.instructions).toContain("ORIGINAL_RULE");
    expect(provider.requests[1]!.instructions).toContain("ORIGINAL_RULE");
    expect(provider.requests[1]!.instructions).not.toContain("CHANGED_MIDTURN");
  });
});
