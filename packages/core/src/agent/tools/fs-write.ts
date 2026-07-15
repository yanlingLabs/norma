import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithinAny } from "../paths";
import type { ToolRegistry } from "./registry";

export function registerWriteTools(r: ToolRegistry): void {
  r.register({
    name: "write",
    description: "Write a file (creates parent directories). Overwrites if it exists.",
    args: z.object({ path: z.string().min(1), content: z.string() }),
    // Out-of-root targets: the engine's dispatch loop (engine.ts's `dirGrant` branch) grants
    // session-scoped access to the containing directory BEFORE this ever runs, so by the time
    // resolveWithinAny reads `roots` here it already includes the grant — this only still throws
    // for a worktree-isolated child (deliberately excluded from grants — see engine.ts's doc
    // comment) or a bare ToolRegistry caller with no engine wiring at all (unit tests).
    run({ path, content }, { roots }) {
      const target = resolveWithinAny(roots, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  });

  r.register({
    name: "edit",
    description: "Replace an exact string in a file. old_string must match exactly (including whitespace) and, unless replace_all is true, be UNIQUE in the file — the edit fails otherwise. replace_all: true replaces every occurrence.",
    args: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
    // Out-of-root targets: same grant-before-dispatch story as `write` above.
    run({ path, old_string, new_string, replace_all }, { roots }) {
      const target = resolveWithinAny(roots, path);
      const text = readFileSync(target, "utf8");
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (!replace_all && count > 1) throw new Error(`old_string matches ${count} occurrences in ${path} — provide a longer unique string`);
      const newText = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      writeFileSync(target, newText);
      return `edited ${path}`;
    },
  });
}
