import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { SkillStore } from "../skills";

/**
 * skill_write (phase 5c Task 2) — the agent-facing surface over SkillStore.writeSelf (durable
 * self-authored skills under ~/.norma/skills/self, `author: norma` stamped by the STORE). PLAIN
 * TOOL, same shape as agent-query.ts/task-stop.ts (deps closure at registration, no engine bridge).
 *
 * Gate class (gate.ts): ALWAYS_ASK — approval-carded under BOTH `ask` AND `auto`, denied under
 * `plan`. A skill is standing instructions, i.e. durable prompt injection into future sessions,
 * so no policy setting may silence the card — see gate.ts's ALWAYS_ASK comment for the full
 * contrast with a memory-fact write's silent-under-`auto` posture (T1: memory writes now go
 * through the plain `write`/`edit` tools, no dedicated tool of their own). Also excluded from
 * every child's tool set (engine.ts childExcludeTools — consent-laundering note there).
 *
 * Throws on a store `ok:false` result (`throw new Error(r.error)`) rather than hand-rolling error
 * text — the store's strings are already precise (slug jail, empty-after-trim description) and
 * ToolRegistry.execute's catch converts any throw into a typed isError tool_result: the SAME
 * "let the registry do the isError conversion" precedent memory.ts/schedule.ts use.
 */
export function registerSkillWriteTool(r: ToolRegistry, deps: { skills: SkillStore }): void {
  const { skills } = deps;

  r.register({
    name: "skill_write",
    description:
      "Save a reusable skill for FUTURE sessions — durable, named instructions loadable via the Skill tool. " +
      "Every call ALWAYS requires the user's approval, even under auto policy. BEFORE authoring, load the " +
      "`writing-skills` skill (via the Skill tool) and follow it. Writing an existing name again overwrites " +
      "that skill (use this to edit, not to append a variant). name: lowercase letters/digits/dashes; " +
      "description: one-line summary shown in the skill index; body: the full skill body (markdown).",
    args: z.object({ name: z.string().min(1), description: z.string().min(1), body: z.string().min(1) }),
    deferred: true,
    async run({ name, description, body }) {
      const res = await skills.writeSelf({ name, description, body });
      if (!res.ok) throw new Error(res.error);
      return `saved skill "${name}" — future sessions can load it via the Skill tool`;
    },
  });
}
