import { z } from "zod";
import type { ToolSpec } from "../../providers/types";

export interface ToolContext {
  cwd: string;
  roots: string[]; // allowed roots; roots[0] MUST be the primary cwd — relative tool paths resolve against it
  tmpDir?: string; // per-session scratch dir (sandbox writable root + child TMPDIR); bash uses it, other tools ignore
}
export interface ToolOutcome { output: string; isError: boolean }

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  args: S;
  /** May throw — the registry converts throws into isError outcomes. */
  run(args: z.infer<S>, ctx: ToolContext): Promise<string> | string;
}

const MAX_OUTPUT = 64 * 1024; // tool outputs are model input — cap them

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.defs.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.defs.set(def.name, def);
  }

  specs(): ToolSpec[] {
    return [...this.defs.values()].map((d) => ({
      name: d.name,
      description: d.description,
      parameters: z.toJSONSchema(d.args),
    }));
  }

  has(name: string): boolean { return this.defs.has(name); }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const def = this.defs.get(name);
    if (!def) return { output: `unknown tool: ${name}`, isError: true };
    const parsed = def.args.safeParse(rawArgs);
    if (!parsed.success) {
      return { output: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`, isError: true };
    }
    try {
      let out = String(await def.run(parsed.data, ctx));
      if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n[truncated at ${MAX_OUTPUT} bytes]`;
      return { output: out, isError: false };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}
