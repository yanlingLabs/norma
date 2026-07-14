import type { Settings } from "./settings";
import type { ToolRegistry } from "./agent/tools/registry";
import type { ComputerUseService } from "./agent/computer-use";
import type { LspManager } from "./agent/lsp/manager";

/** Error → message without assuming the thrown value is an Error (a `throw "str"` must not become
 *  `undefined`). Mirrors settings-watcher.ts's own `msg` helper — kept local rather than shared
 *  since the two files have no other coupling. */
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SettingsApplyDeps {
  /** THE atomic swap: `settings = s` in daemon.ts, a single synchronous assignment. Runs FIRST,
   *  before any await, so value-only reads go live immediately even while a drain awaits below. */
  setLiveSettings: (s: Settings) => void;
  registry: ToolRegistry;
  // computer-use:
  buildComputerService: (s: Settings) => ComputerUseService; // rebuild reading current screenshotMaxDim/peripheral
  registerComputer: (svc: ComputerUseService, s: Settings) => void; // registerComputerTool(registry, {screenshotMaxDim})
  teardownComputer: () => Promise<void> | void; // drain in-flight, then unregister "computer" + stop service
  computerInFlight: () => boolean; // is a `computer` call executing right now? (drain gate)
  // lsp:
  buildLspManager: (s: Settings) => LspManager;
  registerLsp: (mgr: LspManager) => void; // registerLspTools(registry, {...})
  teardownLsp: () => Promise<void> | void; // unregister the 3 lsp tools + lspManager.stopAll()
  drainTimeoutMs?: number; // default 10000 — cap on the CU-disable drain wait
  drainIntervalMs?: number; // default 50 — poll interval while draining
  sleep?: (ms: number) => Promise<void>; // injectable clock (default Bun.sleep) so the cap test never waits real seconds
  log?: (msg: string) => void;
}

/**
 * Builds the `(prev, next) => Promise<void>` apply function the SettingsWatcher (T3) calls on
 * every settled settings.json change. T3 already single-flights (at most one apply in flight at
 * a time), so this function needs no internal locking of its own.
 *
 * Order matters: the atomic swap happens FIRST, synchronously, before either feature-flag diff —
 * so plain value reads (thresholds, models, etc.) go live immediately even while a CU-disable
 * drain below is still awaiting.
 */
export function makeApply(deps: SettingsApplyDeps): (prev: Settings | null, next: Settings) => Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  const drainIntervalMs = deps.drainIntervalMs ?? 50;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? (() => {});

  // Per-flag polarity — the two flags have OPPOSITE defaults, so a single `!!` form is wrong for
  // one of them. These mirror the exact boot gates in daemon.ts so `prev` (boot settings) yields
  // the true registered-at-boot state, INCLUDING the absent-block boundary:
  //   - computerUse: opt-in / default-OFF  (daemon.ts `if (settings?.computerUse?.enabled)`) —
  //     absent block ⇒ NOT registered. `cuEnabled(null)` ⇒ false.
  //   - lsp: opt-out / default-ON (daemon.ts `if (lspCfg?.enabled !== false)`, same `!== false`
  //     convention as hooks/reviewer) — absent block ⇒ registered. `lspEnabled(null)` ⇒ true.
  const cuEnabled = (s: Settings | null) => !!s?.computerUse?.enabled;
  const lspEnabled = (s: Settings | null) => s?.lsp?.enabled !== false;

  async function applyComputerUseDiff(prev: Settings | null, next: Settings): Promise<void> {
    const wasEnabled = cuEnabled(prev);
    const isEnabled = cuEnabled(next);
    if (wasEnabled === isEnabled) return; // no flip — value-only change already applied by the swap

    if (isEnabled) {
      const svc = deps.buildComputerService(next);
      deps.registerComputer(svc, next);
      return;
    }

    // disabling: never yank a live `computer` call — drain first, bounded by drainTimeoutMs.
    // The cap is expressed as an ITERATION count (drainTimeoutMs / drainIntervalMs) over the
    // injected `sleep`, not real Date.now() — so a fast injected sleep makes the whole drain
    // (cap included) resolve near-instantly in tests, regardless of how large drainTimeoutMs is.
    if (deps.computerInFlight()) {
      const maxTicks = Math.max(1, Math.ceil(drainTimeoutMs / drainIntervalMs));
      let ticks = 0;
      while (deps.computerInFlight() && ticks < maxTicks) {
        await sleep(drainIntervalMs);
        ticks++;
      }
      if (deps.computerInFlight()) {
        // cap exceeded — the user's disable intent wins; teardown anyway (never leave CU
        // registered-but-disabled). The in-flight promise will reject when torn down; the engine
        // treats that as a tool error, not a crash.
        log("settings-apply: computerUse disable drain exceeded drainTimeoutMs — tearing down with a call still in flight");
      }
    }
    await deps.teardownComputer();
  }

  async function applyLspDiff(prev: Settings | null, next: Settings): Promise<void> {
    const wasEnabled = lspEnabled(prev);
    const isEnabled = lspEnabled(next);
    if (wasEnabled === isEnabled) return; // no flip

    if (isEnabled) {
      const mgr = deps.buildLspManager(next);
      deps.registerLsp(mgr);
    } else {
      await deps.teardownLsp();
    }
  }

  return async function apply(prev: Settings | null, next: Settings): Promise<void> {
    deps.setLiveSettings(next); // THE ATOMIC SWAP — first, synchronous, one statement.
    // Independent flips: a long CU-disable drain must not stall the LSP re-wire in the same
    // reload, so the two diffs run concurrently.
    //
    // Whole-branch review F1: each diff runs inside its OWN try/catch so a throw in one can NEITHER
    // reject the aggregate apply NOR abandon the other diff. Every register/teardown path is
    // throw-safe today (this is unreachable in practice), but the spec's "never half-applies"
    // guarantee must be STRUCTURAL, not luck: were a diff to throw and propagate, Promise.all would
    // reject → T3's watcher keeps prevSnapshot (no advance) → the NEXT reload re-diffs the SAME
    // flip → re-register throws "duplicate tool" → every subsequent apply throws → CU/LSP hot-apply
    // is dead for the daemon's life. Catching per-flag makes `apply` always resolve (so prevSnapshot
    // advances and there's no re-diff-of-same-flip wedge); a hypothetical single-flag failure
    // degrades to best-effort-until-the-next-change instead of a total permanent wedge. The atomic
    // swap above is deliberately OUTSIDE both try/catches — it's a single synchronous assignment
    // that cannot throw, and it must always win regardless of either diff's fate.
    await Promise.all([
      (async () => {
        try {
          await applyComputerUseDiff(prev, next);
        } catch (err) {
          log(`computerUse diff-apply failed (hot-apply left best-effort until the next change): ${errMsg(err)}`);
        }
      })(),
      (async () => {
        try {
          await applyLspDiff(prev, next);
        } catch (err) {
          log(`lsp diff-apply failed (hot-apply left best-effort until the next change): ${errMsg(err)}`);
        }
      })(),
    ]);
  };
}
