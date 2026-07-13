import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { MemoryStore } from "../memory";

const SCOPE = z.enum(["user", "project"]).default("user");

/**
 * memory_read / memory_write / memory_delete (phase 5b Task 2) — the agent-facing surface over
 * T1's `MemoryStore` (durable fact files + MEMORY.md index + audit log). PLAIN TOOLS, same shape
 * as task-stop.ts/agent-query.ts (deps closure at registration, `ctx.sessionId` at run time) —
 * nothing here needs the engine's dispatch loop.
 *
 * `cwdOf(sessionId)` resolves the SESSION's cwd (daemon.ts wires this from `store.meta(sid).cwd`,
 * the SAME source request-dir.ts's `projectDir` dep already uses) rather than reading `ctx.cwd`
 * directly: `ctx.cwd` is the CURRENT THREAD's cwd, which for an isolated worktree child can
 * diverge from the session's own project directory (see engine.ts's `childCwd`) — project-scope
 * memory must gate on the session's real project, not a transient worktree path. Passed
 * unconditionally to the store (it only consults `cwd` for scope:"project" — see memory.ts's
 * `resolveRoot`), so user-scope calls are unaffected by whatever `cwdOf` returns.
 *
 * All three throw on a store `ok:false` result (`throw new Error(r.error)`) rather than
 * hand-rolling their own error text — the store's error strings are already precise (invalid/
 * reserved name, untrusted project cwd, not-found/corrupt fact) and ToolRegistry.execute's catch
 * converts any throw into a typed isError tool_result (registry.ts), so this is the SAME
 * "let the registry do the isError conversion" precedent schedule.ts/plan.ts/background.ts use.
 *
 * gate.ts classification (see that file for the full rationale): memory_read is READ_ONLY;
 * memory_write/memory_delete are MUTATING. Children deliberately KEEP all three (NOT added to
 * engine.ts's childExcludeTools) — a child's reads/writes gate and audit exactly like the
 * parent's, so excluding them would add complexity without a safety gain (design doc's own
 * "out of scope" note).
 */
export function registerMemoryTools(r: ToolRegistry, deps: { memory: MemoryStore; cwdOf: (sessionId: string) => string | undefined }): void {
  const { memory, cwdOf } = deps;

  r.register({
    name: "memory_read",
    description:
      "Read the full body of a saved memory fact by name (see the MEMORY.md index already in your context for names/descriptions). " +
      'scope defaults to "user"; "project" reads from the current project\'s memory (requires a trusted directory).',
    args: z.object({ scope: SCOPE, name: z.string().min(1) }),
    deferred: true,
    run({ scope, name }, { sessionId }) {
      const res = memory.read(scope, name, cwdOf(sessionId));
      if (!res.ok) throw new Error(res.error);
      const f = res.value;
      return `${f.name} (${f.type}) — ${f.description}\n\n${f.body}`;
    },
  });

  r.register({
    name: "memory_write",
    description:
      "Save a durable fact worth recalling in FUTURE sessions — a user preference, a correction the user gave you, or a project " +
      "constraint. NOT for session-local trivia (task state, one-off details that don't outlive this conversation). One fact per " +
      'entry; writing an existing `name` again overwrites it (use this to update a fact, not to append a second one). scope ' +
      'defaults to "user"; "project" saves under the current project (requires a trusted directory). description is a one-line ' +
      'summary shown in the memory index; type defaults to "user" (also: "feedback", "project", "reference").',
    args: z.object({
      scope: SCOPE,
      name: z.string().min(1),
      description: z.string().min(1),
      type: z.enum(["user", "feedback", "project", "reference"]).default("user"),
      body: z.string().min(1),
    }),
    deferred: true,
    async run({ scope, name, description, type, body }, { sessionId }) {
      const res = await memory.write(scope, { name, description, type, body }, { sessionId, source: "tool" }, cwdOf(sessionId));
      if (!res.ok) throw new Error(res.error);
      return `saved memory fact "${name}" (${scope} scope)`;
    },
  });

  r.register({
    name: "memory_delete",
    description: 'Delete a saved memory fact by name. scope defaults to "user"; "project" deletes from the current project\'s memory (requires a trusted directory).',
    args: z.object({ scope: SCOPE, name: z.string().min(1) }),
    deferred: true,
    async run({ scope, name }, { sessionId }) {
      const res = await memory.delete(scope, name, { sessionId, source: "tool" }, cwdOf(sessionId));
      if (!res.ok) throw new Error(res.error);
      return `deleted memory fact "${name}" (${scope} scope)`;
    },
  });
}
