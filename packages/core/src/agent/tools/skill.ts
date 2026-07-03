import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { SkillStore } from "../skills";

export function registerSkillTools(r: ToolRegistry, deps: { skills: SkillStore }): void {
  r.register({
    name: "Skill",
    description: "Load a skill's full instructions into context so you can follow them. Pass the exact `name` of a skill listed under Available capabilities. The skill stays active for the rest of the session.",
    args: z.object({ name: z.string().min(1) }),
    run: ({ name }, ctx) => {
      const s = deps.skills.load(name, { cwd: ctx.cwd });
      if (!s) throw new Error(`No such skill: ${name}. See Available capabilities for the list of skills.`); // registry → isError
      ctx.markSkillLoaded?.(s.name);
      return s.body;
    },
  });
}
