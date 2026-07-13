// Phase 5b Task 4 — `norma memory list|show <name>|rm <name> [--project]` (main.ts) and `/memory`
// (tui/commands.ts) share this module.
//
// `parseMemoryArgs` is pure argv-in/route-out (routeCliInvocation's precedent in main.ts) so
// `--project` resolution and the usage fallback are unit-testable without a socket, and so
// main.ts can validate BEFORE connecting (routines' "argument validation happens before
// connecting" precedent). `runMemoryRoute` is the ONE client-driven step both `norma memory`'s
// case and its tests share: main.ts's own argv switch can't be driven directly by a unit test
// (routines-cli.ts's header comment explains why) — this is the testable seam that stands in for
// it, exercised with a fake NormaClient the same way tui/commands.test.ts's runners are. It never
// catches: a store failure surfaces as a thrown RpcFailure, same as routines.create/enable/
// disable — the caller's try/catch prints `.message` and exits 1.
//
// The formatters mirror core/src/agent/tools/memory.ts's own memory_read/memory_delete wording
// verbatim so the CLI/tool/slash surfaces read identically, the same way routines-cli.ts's
// formatRoutineDetail/formatRoutineLine are shared by main.ts's colored list and /routines' plain
// note.
import type { NormaClient } from "./client";

export type MemoryScope = "user" | "project";

/** Structural subset of `MemoryFactMeta`/`MemoryFact` (protocol/src/methods.ts) — just the fields
 *  these formatters read, mirroring routines-cli.ts's `RoutineLike` convention. */
export interface MemoryFactMetaLike { name: string; description: string; type: string }
export interface MemoryFactLike extends MemoryFactMetaLike { body: string }

export const MEMORY_USAGE = "usage: norma memory list [--project] | show <name> [--project] | rm <name> [--project]";

export type ResolvedMemoryRoute =
  | { kind: "list"; scope: MemoryScope; cwd?: string }
  | { kind: "show"; scope: MemoryScope; cwd?: string; name: string }
  | { kind: "rm"; scope: MemoryScope; cwd?: string; name: string };

export type MemoryRoute = ResolvedMemoryRoute | { kind: "usage" };

/** argv (everything after "memory") -> a route. `--project` (anywhere in args) resolves
 *  scope:"project" + cwd = the CALLER's own cwd (the brief: project scope passes the
 *  session-less RPC an explicit cwd = process.cwd()) — mirrors memory_read/write/delete's own
 *  `SCOPE.default("user")`. No subcommand, or "list", -> list. "show"/"rm" require a <name>; its
 *  absence, or any other subcommand, -> {kind:"usage"} — checked before connecting, never opens a
 *  socket on a bad invocation. */
export function parseMemoryArgs(args: string[], cwd: string): MemoryRoute {
  const isProject = args.includes("--project");
  const rest = args.filter((a) => a !== "--project");
  const scope: MemoryScope = isProject ? "project" : "user";
  const scopedCwd = isProject ? cwd : undefined;
  const [sub, name] = rest;
  if (sub === undefined || sub === "list") return { kind: "list", scope, cwd: scopedCwd };
  if (sub === "show") return name ? { kind: "show", scope, cwd: scopedCwd, name } : { kind: "usage" };
  if (sub === "rm") return name ? { kind: "rm", scope, cwd: scopedCwd, name } : { kind: "usage" };
  return { kind: "usage" };
}

export type MemoryRouteResult =
  | { kind: "list"; facts: MemoryFactMetaLike[] }
  | { kind: "show"; fact: MemoryFactLike }
  | { kind: "rm"; name: string; scope: MemoryScope };

/** Calls the one memory.* RPC an already-resolved (non-"usage") route needs and returns the raw
 *  result. See the file header for why this — not main.ts's switch itself — is the tested seam. */
export async function runMemoryRoute(
  client: Pick<NormaClient, "memoryList" | "memoryRead" | "memoryDelete">,
  route: ResolvedMemoryRoute,
): Promise<MemoryRouteResult> {
  if (route.kind === "list") {
    const { facts } = await client.memoryList(route.scope, route.cwd);
    return { kind: "list", facts };
  }
  if (route.kind === "show") {
    const { fact } = await client.memoryRead(route.scope, route.name, route.cwd);
    return { kind: "show", fact };
  }
  await client.memoryDelete(route.scope, route.name, route.cwd);
  return { kind: "rm", name: route.name, scope: route.scope };
}

/** "(type) — description" — mirrors memory_read's own tool-result wording
 *  (core/src/agent/tools/memory.ts: `` `${f.name} (${f.type}) — ${f.description}` ``) split at
 *  the name/rest boundary so main.ts can color just the name AQUA (formatRoutineDetail's own
 *  split convention). */
export function formatFactDetail(f: MemoryFactMetaLike): string {
  return `(${f.type}) — ${f.description}`;
}

/** Full plain "name (type) — description" line — what `/memory` prints verbatim (no color,
 *  mirrors /skills' own inline "name (source) — description" template) and what `norma memory
 *  list`'s colored line wraps AQUA/DIM around. */
export function formatFactLine(f: MemoryFactMetaLike): string {
  return `${f.name} ${formatFactDetail(f)}`;
}

/** `norma memory list` / `/memory`'s full body: one line per fact, or the empty-state fallback. */
export function formatMemoryList(facts: MemoryFactMetaLike[]): string[] {
  return facts.length === 0 ? ["(no memory facts)"] : facts.map((f) => formatFactLine(f));
}

/** `norma memory rm <name>`'s confirmation — mirrors memory_delete's own tool-result wording
 *  (`` `deleted memory fact "${name}" (${scope} scope)` ``). */
export function formatDeleted(name: string, scope: MemoryScope): string {
  return `deleted memory fact "${name}" (${scope} scope)`;
}
