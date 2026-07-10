import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { SkillStore } from "../skills";

/**
 * Trailing nudge on the tool RESULT only (never the sticky per-turn re-injection via
 * SkillStore.load): 4e live gate caught codex models ending the turn right after ANNOUNCING a
 * freshly loaded skill (gate ledger F1) — the announcement is a step, not the deliverable.
 * Phrased to still allow legitimately turn-ending first steps (e.g. brainstorming's first
 * question to the user).
 */
const SKILL_CONTINUE_SUFFIX =
  "\n\n[Skill loaded. Do not stop after announcing it: continue in this same turn by taking the skill's first concrete step (if that step is asking the user something, ask it now).]";

export function registerSkillTools(r: ToolRegistry, deps: { skills: SkillStore }): void {
  r.register({
    name: "Skill",
    description: "Load a skill's full instructions into context so you can follow them. Pass the exact `name` of a skill listed under Available capabilities. The skill stays active for the rest of the session.",
    args: z.object({ name: z.string().min(1) }),
    run: ({ name }, ctx) => {
      const s = deps.skills.load(name, { cwd: ctx.cwd });
      if (!s) throw new Error(`No such skill: ${name}. See Available capabilities for the list of skills.`); // registry → isError
      ctx.markSkillLoaded?.(s.name);
      return s.body + SKILL_CONTINUE_SUFFIX;
    },
  });
}
