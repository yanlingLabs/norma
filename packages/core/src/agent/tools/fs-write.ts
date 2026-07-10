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
    run({ path, content }, { roots }) {
      let target: string;
      try {
        target = resolveWithinAny(roots, path);
      } catch (e) {
        throw new Error(`${(e as Error).message} — call request_directory to ask the user for write access to that location`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  });

  r.register({
    name: "edit",
    description: "Replace an exact string in a file. old_string must match exactly (including whitespace) and, unless replace_all is true, be UNIQUE in the file — the edit fails otherwise. replace_all: true replaces every occurrence.",
    args: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
    run({ path, old_string, new_string, replace_all }, { roots }) {
      let target: string;
      try {
        target = resolveWithinAny(roots, path);
      } catch (e) {
        throw new Error(`${(e as Error).message} — call request_directory to ask the user for write access to that location`);
      }
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
