import type { Settings } from "./settings";
import type { ToolRegistry } from "./agent/tools/registry";
import type { ComputerUseService } from "./agent/computer-use";
import type { LspManager } from "./agent/lsp/manager";

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

  async function applyComputerUseDiff(prev: Settings | null, next: Settings): Promise<void> {
    const wasEnabled = !!prev?.computerUse?.enabled;
    const isEnabled = !!next?.computerUse?.enabled;
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
    const wasEnabled = !!prev?.lsp?.enabled;
    const isEnabled = !!next?.lsp?.enabled;
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
    await Promise.all([applyComputerUseDiff(prev, next), applyLspDiff(prev, next)]);
  };
}
