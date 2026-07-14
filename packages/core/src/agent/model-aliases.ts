/**
 * Short model aliases (CC parity: spawn_agent `model` accepts a short name like "sol"/"terra"/
 * "luna" as well as the provider's full model id, e.g. "gpt-5.6-sol"). Pure/exported so both sides
 * of the feature — engine.ts's runtime resolution (the spawn bridge's model-override gate) and
 * daemon.ts's schema-facing enum construction (registerSpawnAgentTool's `models` list) — share
 * ONE definition of "what counts as an alias", and so each is directly unit-testable without a
 * live provider/engine.
 */

/** Resolves `override` against `knownIds` (the calling provider's own `models()` ids): if
 *  `override` is already a known full id, it's returned unchanged; otherwise, if EXACTLY ONE known
 *  id ends with `-<override>` (e.g. "sol" → "gpt-5.6-sol"), that full id is returned. An ambiguous
 *  match (two or more known ids share the same trailing `-<override>` segment) or no match at all
 *  returns `override` UNCHANGED — the caller's existing "unknown model" validation is what
 *  ultimately rejects it, so an unresolvable alias fails exactly the same way a plain unknown
 *  string always has (no new error path to keep in sync). */
export function resolveModelAlias(override: string, knownIds: string[]): string {
  if (knownIds.includes(override)) return override;
  const matches = knownIds.filter((id) => id.endsWith(`-${override}`));
  return matches.length === 1 ? matches[0]! : override;
}

/** Derives the set of UNAMBIGUOUS short aliases implied by `knownIds` — the trailing `-<suffix>`
 *  segment of each id, kept only when exactly one known id produces that suffix (mirrors
 *  `resolveModelAlias`'s own uniqueness rule, so an alias this function offers is guaranteed to be
 *  the same one `resolveModelAlias` would actually resolve at spawn time — never a schema-level
 *  promise the runtime gate would then reject as ambiguous). An id with no `-` contributes no
 *  alias. Used by daemon.ts to extend the spawn tool's zod enum with short names ALONGSIDE the
 *  full ids (never replacing them). */
export function deriveModelAliases(knownIds: string[]): string[] {
  const countBySuffix = new Map<string, number>();
  for (const id of knownIds) {
    const i = id.lastIndexOf("-");
    if (i < 0) continue;
    const suffix = id.slice(i + 1);
    countBySuffix.set(suffix, (countBySuffix.get(suffix) ?? 0) + 1);
  }
  return [...countBySuffix.entries()].filter(([, count]) => count === 1).map(([suffix]) => suffix);
}
