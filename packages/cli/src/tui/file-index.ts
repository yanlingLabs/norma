/** Pure fuzzy-matcher + fs walker backing the composer's "@"-file mention menu (Phase 3d Task 3).
 *  Two independent halves, deliberately split: `fuzzyMatch` is pure (no I/O, trivially unit-tested
 *  with a plain string array); `buildFileIndex` is the one fs-touching piece, walking a directory
 *  tree into the flat relative-path list `fuzzyMatch` then searches. The composer never calls
 *  `buildFileIndex` itself — `<App>` owns the one-per-session build (see app.tsx's `fileIndexRef`
 *  doc) and threads the resolved list down as a prop; this module only supplies the two pure/async
 *  functions, no React/Ink here. */

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, posix, relative } from "node:path";

// ---- fuzzyMatch -----------------------------------------------------------------------------

/** Case-insensitive subsequence test — same shape as commands.ts's `isFuzzySubsequence`, just
 *  named for this module and early-exiting once the whole query is consumed. */
function isSubsequence(query: string, text: string): boolean {
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** The length of the longest substring of `query` that also appears (contiguously) anywhere in
 *  `text` — the "contiguous run" ranking factor. Deliberately NOT derived from the subsequence
 *  match itself (a greedy leftmost-subsequence walk can miss a later contiguous run — e.g. "abc"
 *  against "aabc" greedily consumes the first "a" and never notices the contiguous "abc" at index
 *  1) — this checks every (start, length) slice of `query` against `text` directly instead, so it
 *  always finds the true longest contiguous overlap regardless of how the subsequence aligns.
 *  Query strings here are short (a few typed characters), so the O(query.length^2) slices, each a
 *  single `String#includes` call, is cheap. */
function longestCommonRun(query: string, text: string): number {
  let best = 0;
  for (let start = 0; start < query.length; start++) {
    for (let len = query.length - start; len > best; len--) {
      if (text.includes(query.slice(start, start + len))) {
        best = len;
        break;
      }
    }
  }
  return best;
}

/** Fuzzy subsequence search over `candidates` (relative file paths), ranked per the brief: a
 *  basename prefix/contains bonus outranks everything else, then the longest contiguous run
 *  shared between the query and the candidate, then a shorter overall path — ties are left
 *  exactly as `Array#sort`'s stable ordering resolves them (the candidates' original relative
 *  order), so equally-ranked entries never get shuffled. An empty query is a special case with no
 *  ranking at all: it returns the first `limit` candidates verbatim (there's nothing to rank an
 *  empty match against). */
export function fuzzyMatch(query: string, candidates: string[], limit = 20): string[] {
  if (query === "") return candidates.slice(0, limit);
  const q = query.toLowerCase();

  const scored: { candidate: string; bonus: number; run: number }[] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (!isSubsequence(q, lower)) continue;
    const base = posix.basename(lower);
    const bonus = base.startsWith(q) ? 2 : base.includes(q) ? 1 : 0;
    const run = longestCommonRun(q, lower);
    scored.push({ candidate, bonus, run });
  }

  scored.sort((a, b) => {
    if (a.bonus !== b.bonus) return b.bonus - a.bonus;
    if (a.run !== b.run) return b.run - a.run;
    if (a.candidate.length !== b.candidate.length) return a.candidate.length - b.candidate.length;
    return 0; // true tie — stable sort keeps the candidates' original relative order
  });

  return scored.slice(0, limit).map((s) => s.candidate);
}

// ---- buildFileIndex --------------------------------------------------------------------------

/** Directory names skipped outright wherever they appear (in addition to the generic "any
 *  dot-directory" rule below, which already covers `.git` and `.build` — listed in the brief
 *  anyway for a self-contained doc, but not duplicated in this set since they'd never reach it). */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "DerivedData"]);

const DEFAULT_MAX_ENTRIES = 2000;

/** BFS/DFS-order walk of `root` into a flat, sorted list of POSIX-style relative file paths, for
 *  the composer's "@"-mention index. Directories named `.git`/`node_modules`/`dist`/`.build`/
 *  `DerivedData`, or any directory whose name starts with `.`, are skipped entirely (not
 *  descended into). Symlinks — both directories and files — are skipped outright too: the brief's
 *  hard requirement is loop safety ("follows NO symlinked dirs"), and the simplest rule that
 *  trivially guarantees that (checking `entry.isSymbolicLink()` BEFORE ever following/statting the
 *  target, so a cyclic target is never even touched) is to not follow any symlink at all, file or
 *  dir alike — a symlinked file surfacing under a second path would be a more surprising outcome
 *  than simply omitting it. Never throws: an unreadable directory (`readdir` rejecting) is
 *  skipped, not fatal — best-effort, same convention as history-store.ts's disk I/O. Stops walking
 *  the moment `maxEntries` (default 2000) is reached, rather than collecting everything and
 *  truncating after — this bounds a huge tree's traversal cost, not just its returned array size.
 *  Entries at each directory level are visited in name order so a capped walk is deterministic; the
 *  final list is sorted too (a DFS walk doesn't itself produce a globally-sorted list once nested
 *  directories are involved), satisfying "sorted for determinism" at the whole-list level as well. */
export async function buildFileIndex(root: string, opts?: { maxEntries?: number }): Promise<string[]> {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race with deletion, ...) — skip, don't throw
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      if (entry.isSymbolicLink()) continue; // never follow, never include (see doc above)
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        // `node:path`'s default (non-`.posix`) `join`/`relative` already use "/" on the
        // POSIX platforms this CLI targets (macOS/Linux) — no separate normalization needed.
        results.push(relative(root, full));
      }
    }
  }

  try {
    await walk(root);
  } catch {
    // Belt-and-suspenders: `walk` already catches its own readdir errors, but this guarantees the
    // "never throws" contract even against an unexpected error from `join`/`relative` themselves.
  }

  results.sort();
  return results.slice(0, maxEntries);
}
