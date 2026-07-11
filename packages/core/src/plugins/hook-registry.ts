/**
 * HookRegistry — the enabled-plugins' manifest hooks, indexed per event (Phase 4f design §Architecture,
 * plan Task 2). Sits between HookRunner (pure process mechanics, Task 1, FROZEN) and the engine
 * cfg.hooks facade (below): a flat, plugin-order-preserving `event -> HookSpec[]` index, rebuilt
 * wholesale whenever the daemon's enabled-plugin set changes (boot scan, plugin.enable/disable/
 * remove/setConsent — daemon.ts/ipc/server.ts, mirroring how contributes.mcpServers attaches).
 * Deliberately dumb: no eligibility filtering (that's plugins.ts's `pluginHooksEligible` — the
 * caller passes only already-eligible plugins in), no I/O, no async.
 */
import type { HookEventPayload, HookResult, HookSpec } from "./hook-runner";

/** One plugin's worth of input to `rebuild()` — dir becomes every one of its hooks' `cwd`. */
export interface HookRegistryPlugin {
  id: string;
  dir: string;
  hooks: Array<{ event: string; command: string; timeoutMs?: number }>;
}

export class HookRegistry {
  private byEvent = new Map<string, HookSpec[]>();

  /** Replaces the ENTIRE index — not a merge. Callers always pass the full current eligible-plugin
   *  set (e.g. `allPlugins.filter(pluginHooksEligible)`), so a plugin that's since been disabled or
   *  had a hook removed simply isn't in the next `rebuild()` call and drops out of every event's
   *  list, same as `PluginContribRegistry`/`McpManager.startPlugins` treat their own "current set". */
  rebuild(plugins: HookRegistryPlugin[]): void {
    const next = new Map<string, HookSpec[]>();
    for (const plugin of plugins) {
      for (const hook of plugin.hooks) {
        const spec: HookSpec = { pluginId: plugin.id, command: hook.command, cwd: plugin.dir };
        if (hook.timeoutMs !== undefined) spec.timeoutMs = hook.timeoutMs;
        const list = next.get(hook.event);
        if (list) list.push(spec);
        else next.set(hook.event, [spec]);
      }
    }
    this.byEvent = next;
  }

  /** Every hook registered for `event`, in plugin order (the order `rebuild()`'s `plugins` array
   *  listed them) — [] for an event with none, including before the first `rebuild()` call. */
  hooksFor(event: string): HookSpec[] {
    return this.byEvent.get(event) ?? [];
  }
}

/** The subset of HookRunner's interface the facade depends on — lets tests inject a fake runner
 *  (no real process spawns) without importing HookRunner's concrete class. */
export interface HookRunnerLike {
  run(spec: HookSpec, payload: HookEventPayload): Promise<HookResult>;
}

export interface HookFacadeDeps {
  registry: HookRegistry;
  runner: HookRunnerLike;
  /** Hot per-call read of `settings.hooks.enabled` (default true — see settings.ts's
   *  `hooksEnabledFrom`). Called AFTER the no-hooks fast path (see runFor's doc comment) so an
   *  event with nothing registered never touches settings at all. */
  hooksEnabled: () => boolean;
}

/**
 * The engine-facing `cfg.hooks` facade (Phase 4f Task 2 — Task 3 is the engine's 4 call sites that
 * consume this). Composes a HookRegistry + a HookRunner-shaped runner + a hot settings-reader,
 * taking all three as constructor deps (not globals) so this class is unit-testable with a fake
 * runner and no real process spawns, and so daemon.ts can wire the SAME registry instance that
 * ipc/server.ts's plugin-lifecycle RPCs rebuild in place.
 */
export class HookFacade {
  constructor(private readonly deps: HookFacadeDeps) {}

  /**
   * Runs every hook registered for `event`, in registry (plugin) order, building each one's
   * payload as `{event, sessionId, pluginId, ts: Date.now(), ...extra}` (Task 1's HookEventPayload
   * shape). Fast path: `hooksFor(event).length === 0` short-circuits BEFORE `hooksEnabled()` is
   * even called — an event nobody registered for never reads settings, preserving the "additive:
   * zero enabled hooks -> zero behavior change" guarantee even when hooks are globally disabled or
   * settings.json is momentarily unreadable. Execution is SEQUENTIAL (awaited one at a time, never
   * Promise.all/.map) — for `event === "pre-tool"` ONLY, the first result with `status === "blocked"`
   * stops the loop (deny-only short-circuit per design F1); every other event always runs its full
   * list regardless of any individual hook's outcome (observe-only, per plan: "other events run
   * all").
   */
  async runFor(event: string, extra: Record<string, unknown>, sessionId: string): Promise<Array<{ pluginId: string; result: HookResult }>> {
    const specs = this.deps.registry.hooksFor(event);
    if (specs.length === 0 || !this.deps.hooksEnabled()) return [];

    const results: Array<{ pluginId: string; result: HookResult }> = [];
    for (const spec of specs) {
      const payload: HookEventPayload = { event, sessionId, pluginId: spec.pluginId, ts: Date.now(), ...extra };
      const result = await this.deps.runner.run(spec, payload);
      results.push({ pluginId: spec.pluginId, result });
      if (event === "pre-tool" && result.status === "blocked") break;
    }
    return results;
  }
}
