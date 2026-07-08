import { z } from "zod";
import type { Question, Task } from "@norma/protocol";
import type { ToolSpec } from "../../providers/types";
import { isWithin } from "../paths";
import type { AskOutcome } from "../questions";

export interface ToolContext {
  cwd: string;
  roots: string[]; // allowed roots; roots[0] MUST be the primary cwd — relative tool paths resolve against it
  tmpDir?: string; // per-session scratch dir (sandbox writable root + child TMPDIR); bash uses it, other tools ignore
  sessionId: string; // needed by request_directory (approvals/dirs are keyed per-session); other tools ignore it
  signal?: AbortSignal; // aborts when the turn is interrupted; long-running tools (bash) should honor it
  markSkillLoaded?: (name: string) => void; // set by the engine; the Skill tool calls it to pin a loaded skill for the session
  markToolLoaded?: (name: string) => void; // set by the engine; the ToolSearch tool calls it to pin a deferred tool's schema as loaded for the session
  loadedTools?: Set<string>; // mcp__/plugin__ tools whose schema has been loaded via ToolSearch this session; consulted by execute's deferral reject
  deferThreshold?: number; // when set and cwd-visible mcp__/plugin__ tool count exceeds it, deferral is active for this session
  ask?: (questions: Question[]) => Promise<AskOutcome>; // engine bridge: emits question_asked/question_resolved events and blocks on the QuestionBroker; the ask_user tool calls it
  taskEvent?: (task: Task) => void; // engine bridge: emits task_updated; called by the task tools (task_create/task_update/task_list)
}
export interface ToolOutcome { output: string; isError: boolean }

/** Tool names ridden by ToolSearch deferral (registry.ts) and gated as external code by the
 *  permission gate (agent/gate.ts) — MCP server tools (`mcp__<server>__<tool>`) and Phase 4b
 *  platform-plugin tools (`plugin__<pluginId>__<tool>`) are treated IDENTICALLY everywhere this
 *  predicate is used: the visible-count threshold, the deferred index, specs() filtering,
 *  execute()'s runtime guard, and the gate's approval-per-policy branch. One predicate here means
 *  a new deferrable/gated namespace later is a one-line change instead of an N-site grep. */
export function isExternalToolName(name: string): boolean {
  return name.startsWith("mcp__") || name.startsWith("plugin__");
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  args: S;
  rawParameters?: Record<string, unknown>;
  /** If set, the tool is only visible/callable from sessions whose cwd is within this directory (or a descendant of it). */
  scope?: string;
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

  /** Deferral is active for a (cwd, threshold) when the caller provided a threshold AND more than
   *  that many external (mcp__/plugin__ — isExternalToolName) tools are visible. ONE definition —
   *  specs/deferredIndex/execute all use it. */
  private deferralActive(cwd: string | null | undefined, deferThreshold?: number): boolean {
    if (deferThreshold === undefined) return false;
    let n = 0;
    for (const d of this.defs.values()) {
      if (isExternalToolName(d.name) && (!d.scope || (!!cwd && isWithin(cwd, d.scope)))) n++;
    }
    return n > deferThreshold;
  }

  private toSpec(d: ToolDefinition): ToolSpec {
    return { name: d.name, description: d.description, parameters: d.rawParameters ?? z.toJSONSchema(d.args) };
  }

  specs(cwd?: string | null, opts?: { loaded?: Set<string>; deferThreshold?: number }): ToolSpec[] {
    const active = this.deferralActive(cwd, opts?.deferThreshold);
    return [...this.defs.values()]
      .filter((d) => !d.scope || (!!cwd && isWithin(cwd, d.scope)))
      .filter((d) => {
        if (d.name === "ToolSearch") return active; // only useful while something is deferred
        if (!active || !isExternalToolName(d.name)) return true; // built-ins/non-external always; everything when inactive
        return opts?.loaded?.has(d.name) ?? false; // deferred: only loaded external tools ride along
      })
      .map((d) => this.toSpec(d));
  }

  deferredIndex(cwd?: string | null, loaded?: Set<string>, deferThreshold?: number): Array<{ name: string; description: string }> {
    if (!this.deferralActive(cwd, deferThreshold)) return [];
    return [...this.defs.values()]
      .filter((d) => isExternalToolName(d.name) && (!d.scope || (!!cwd && isWithin(cwd, d.scope))) && !(loaded?.has(d.name) ?? false))
      .map((d) => ({ name: d.name, description: d.description.slice(0, 150) }));
  }

  specFor(name: string, cwd?: string | null): ToolSpec | undefined {
    const d = this.defs.get(name);
    if (!d || (d.scope && !(cwd && isWithin(cwd, d.scope)))) return undefined;
    return this.toSpec(d);
  }

  has(name: string): boolean { return this.defs.has(name); }

  unregister(name: string): void { this.defs.delete(name); }

  /** Removes every tool whose name starts with `prefix` — used by ipc/server.ts to unregister an
   *  entire plugin's `plugin__<id>__` tool set at once (on connection disconnect or the
   *  supervisor's circuit breaker opening) without the caller having to track individual tool
   *  names itself. A no-op (never throws) when nothing matches. */
  unregisterByPrefix(prefix: string): void {
    for (const name of this.defs.keys()) {
      if (name.startsWith(prefix)) this.defs.delete(name);
    }
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const def = this.defs.get(name);
    if (!def) return { output: `unknown tool: ${name}`, isError: true };
    const parsed = def.args.safeParse(rawArgs);
    if (!parsed.success) {
      return { output: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`, isError: true };
    }
    if (def.scope && !(ctx.cwd && isWithin(ctx.cwd, def.scope))) {
      return { output: `tool ${name} is not available in this directory`, isError: true };
    }
    if (isExternalToolName(def.name) && this.deferralActive(ctx.cwd, ctx.deferThreshold) && !(ctx.loadedTools?.has(def.name) ?? false)) {
      return { output: `tool ${name} is deferred — load its schema via ToolSearch first`, isError: true };
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
