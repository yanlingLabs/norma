import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { ContextAssembler } from "../../src/agent/context";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// Mirrors engine.test.ts's `done`/`text` helpers.
const done = (reason: "end_turn" | "tool_calls") => ({ type: "done" as const, stopReason: reason });

describe("engine: session-sticky loaded skills", () => {
  test("a skill loaded via the Skill tool in turn 1 is injected into turn 2's instructions, but NOT turn 1's (assembled before the call)", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-esk-home-")));
    mkdirSync(join(home, "skills", "haiku"), { recursive: true });
    writeFileSync(
      join(home, "skills", "haiku", "SKILL.md"),
      "---\nname: haiku\ndescription: write haikus\n---\nHAIKU_STICKY_BODY\n",
    );
    const trust = new TrustStore(join(home, "trust.json"));
    const skills = new SkillStore({ normaHome: home, trust });
    const assembler = new ContextAssembler({ normaHome: home, trust, skills });

    // Turn 1, round 0: the model calls Skill("haiku") → tool_calls. Turn 1, round 1: end_turn.
    // Turn 2, round 0 (script exhausted → replays the last entry): a plain end_turn round.
    const provider = new FakeProvider([
      [
        { type: "tool_call", callId: "c1", name: "Skill", argsJson: JSON.stringify({ name: "haiku" }) },
        done("tool_calls"),
      ],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);

    const { engine, sessionId } = setupEngine(provider, { assembler, skills });

    await engine.runTurn(sessionId); // turn 1: loads the skill mid-turn, then ends
    expect(provider.requests.length).toBe(2); // round 0 (tool call) + round 1 (end_turn)
    // Assembled BEFORE the Skill call (once per turn, at turn start) — must NOT contain the body.
    expect(provider.requests[0]!.instructions).not.toContain("HAIKU_STICKY_BODY");
    // Same-turn re-assembly is disallowed (1c-i security fix) — round 1 shares turn 1's instructions.
    expect(provider.requests[1]!.instructions).not.toContain("HAIKU_STICKY_BODY");

    await engine.runTurn(sessionId); // turn 2: plain end_turn, but now sticky
    expect(provider.requests.length).toBe(3);
    expect(provider.requests[2]!.instructions).toContain("HAIKU_STICKY_BODY");
    // F1 (4e gate ledger): the continue-nudge belongs on the Skill tool RESULT only — the
    // sticky per-turn re-injection (SkillStore.load, feeding the assembler) must NOT repeat it.
    expect(provider.requests[2]!.instructions).not.toContain("Skill loaded. Do not stop after announcing it");
  });
});
