import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import type { ProviderEvent } from "../../src/providers/types";
import { registerSkillTools } from "../../src/agent/tools/skill";
import { registerSkillWriteTool } from "../../src/agent/tools/skill-write";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { setup } from "./engine-spawn.test";

// Phase 5c Task 5: the closing e2e for the PHASE GATE ("Norma writes a skill and reuses it").
// Contrast with 5b T6's memory-e2e (the harness model, reused verbatim below): memory_write is
// PLAIN MUTATING (silent under `auto`); skill_write is ALWAYS_ASK (gate.ts) — a card on EVERY
// call, `auto` included, because a landed skill is standing instructions for every FUTURE
// session, not a fact the model merely weighs. This file proves that posture end to end through
// the real engine (not just gate.test.ts's unit-level PermissionGate.evaluate assertions), closes
// 5b T6's own ordering-assertion gap (approval resolved BEFORE the tool_result — an explicit
// index comparison, not just both-present), and proves the write→reuse loop: a LATER turn's
// `Skill` tool call loads the just-authored skill and its body reaches the provider as the
// tool_result.
//
// Harness: `setup` exported from engine-spawn.test.ts (fake provider + real AgentEngine +
// ToolRegistry + SessionHub) — memory-e2e.test.ts's own precedent. Skill tools are registered
// directly onto the returned registry with a temp-home SkillStore, same idiom
// registerMemoryTools uses there. A REAL TrustStore (not a stub object) is required here — unlike
// MemoryStore's constructor (`Pick<TrustStore, "isTrusted">`), SkillStore's declares `trust:
// TrustStore` outright, so a plain `{ isTrusted: () => true }` literal does not satisfy it
// (private fields make the class non-structurally-assignable) — engine-skills.test.ts /
// skill.test.ts / skill-write.test.ts all construct a real TrustStore for this reason.

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-skill-e2e-")));
}

function freshSkillStore() {
  const normaHome = realDir();
  const trust = new TrustStore(join(normaHome, "trust.json"));
  return { normaHome, skills: new SkillStore({ normaHome, trust }) };
}

type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

// The exact phrase the phase gate cares about: authored in turn 1's body, must reach the
// provider verbatim via turn 2's Skill tool_result.
const AUTHORED_BODY = "This is the phase-5c phase-gate demo skill. Norma writes a skill and reuses it.";

describe("self-authored skill e2e (phase 5c Task 5 — the phase gate)", () => {
  test("auto policy still cards skill_write (ALWAYS_ASK), resolved BEFORE the tool_result; write lands as self/norma; a LATER turn's Skill call reuses the authored body", async () => {
    const { normaHome, skills } = freshSkillStore();

    const { engine, sessionId, registry, cwd, events, hub, broker } = setup(
      [
        [{ type: "tool_call", callId: "w1", name: "skill_write", argsJson: JSON.stringify({ name: "self-demo", description: "Demonstrates self-authored reuse", body: AUTHORED_BODY }) }, done("tool_calls")],
        text("wrote the skill"), // turn 1's own wrap-up round
        [{ type: "tool_call", callId: "s1", name: "Skill", argsJson: JSON.stringify({ name: "self-demo" }) }, done("tool_calls")],
        text("used the skill"), // turn 2's own wrap-up round
      ],
      { approvalPolicy: "auto" },
    );
    registerSkillWriteTool(registry, { skills });
    registerSkillTools(registry, { skills });

    // watcher approves the card as soon as it sees it — must attach before runTurn (same
    // ordering constraint as every other approval-flow test in this suite).
    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    // turn 1: the model authors a skill under AUTO policy.
    await engine.runTurn(sessionId);

    // THE PIN (contrast with memory's e2e): under `auto`, skill_write is STILL carded —
    // ALWAYS_ASK overrides policy entirely, unlike memory_write's audit-instead-of-card posture.
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: true, by: "auto-approver" });

    // ORDERING (closes 5b T6's gap): resolution must precede the tool_result in event order, not
    // merely both be present somewhere in the stream.
    const resolvedIdx = events.findIndex((e) => e.type === "approval_resolved");
    const resultIdx = events.findIndex((e) => e.type === "tool_result" && e.callId === "w1");
    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(resolvedIdx);

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(writeResult.isError).toBe(false);

    // write lands: listed as source "self", author stamped "norma" by the STORE (not the model).
    const metas = skills.list({ cwd }).filter((m) => m.name === "self-demo");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ source: "self", author: "norma" });

    // turn 2: a LATER turn's Skill call loads the just-authored skill — its body reaches the
    // provider as the tool_result. THE PHASE GATE: Norma writes a skill and reuses it.
    await engine.runTurn(sessionId);
    const skillResult = events.find((e) => e.type === "tool_result" && e.callId === "s1") as ToolResult;
    expect(skillResult.isError).toBe(false);
    expect(skillResult.output).toContain("Norma writes a skill and reuses it");
  });

  test("deny variant: watcher denies → no file written, typed denied tool_result", async () => {
    const { normaHome, skills } = freshSkillStore();

    const { engine, sessionId, registry, events, hub, broker } = setup(
      [
        [{ type: "tool_call", callId: "w1", name: "skill_write", argsJson: JSON.stringify({ name: "self-demo-deny", description: "d", body: "b" }) }, done("tool_calls")],
        text("acknowledged the denial"), // unreachable: deniedByHuman ends the turn before this round
      ],
      { approvalPolicy: "auto" },
    );
    registerSkillWriteTool(registry, { skills });
    registerSkillTools(registry, { skills });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);

    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "auto-denier" });
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(writeResult.isError).toBe(true);
    expect(writeResult.output).toMatch(/denied/);

    // NO file written — fs asserted directly, not inferred from the tool_result's shape alone.
    expect(existsSync(join(normaHome, "skills", "self", "self-demo-deny"))).toBe(false);
    expect(skills.list({ cwd: null }).some((m) => m.name === "self-demo-deny")).toBe(false);
  });
});
