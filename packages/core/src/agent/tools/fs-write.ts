import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithin } from "../paths";
import type { ToolRegistry } from "./registry";

export function registerWriteTools(r: ToolRegistry): void {
  r.register({
    name: "write",
    description: "Write a file (creates parent directories). Overwrites if it exists.",
    args: z.object({ path: z.string().min(1), content: z.string() }),
    run({ path, content }, { cwd }) {
      const target = resolveWithin(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  });

  r.register({
    name: "edit",
    description: "Replace an exact unique string in a file with a new string.",
    args: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
    run({ path, old_string, new_string }, { cwd }) {
      const target = resolveWithin(cwd, path);
      const text = readFileSync(target, "utf8");
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (count > 1) throw new Error(`old_string matches ${count} occurrences in ${path} — provide a longer unique string`);
      writeFileSync(target, text.replace(old_string, new_string));
      return `edited ${path}`;
    },
  });
}
