import fs from "node:fs";
import type { Settings } from "./settings";

/** Error → message without assuming the thrown value is an Error (a `throw "str"` must not
 *  become `undefined`). Used for both the load-throw and apply-throw log lines. */
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SettingsWatcherDeps {
  path: string; // dirs.settingsPath
  load: (path: string) => Settings; // loadSettings (throws on parse failure)
  apply: (prev: Settings | null, next: Settings) => void; // the atomic swap + feature-flag diff (T4 wires the real one)
  debounceMs?: number; // default 150
  watch?: (path: string, cb: () => void) => { close(): void }; // injectable fs.watch seam for tests
  log?: (msg: string) => void;
}

/**
 * Watches settings.json for changes, debounces bursts, reloads with keep-last-good on a torn
 * file, and calls the injected `apply(prev, next)` exactly once per settled good change. Owns
 * only the prev-snapshot used for diffing — the actual reference swap lives in `apply` (T4).
 */
export class SettingsWatcher {
  private readonly path: string;
  private readonly load: (path: string) => Settings;
  private readonly apply: (prev: Settings | null, next: Settings) => void;
  private readonly debounceMs: number;
  private readonly watchFn: (path: string, cb: () => void) => { close(): void };
  private readonly log: (msg: string) => void;

  private prevSnapshot: Settings | null = null;
  private watcher: { close(): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(deps: SettingsWatcherDeps) {
    this.path = deps.path;
    this.load = deps.load;
    this.apply = deps.apply;
    this.debounceMs = deps.debounceMs ?? 150;
    this.watchFn =
      deps.watch ??
      ((p, cb) => {
        const w = fs.watch(p, () => cb());
        return { close: () => w.close() };
      });
    this.log = deps.log ?? (() => {});
  }

  start(prev: Settings | null): void {
    // Idempotent re-arm: if already watching (double start), close the old fs.watch handle and
    // clear any pending timer first so the previous watcher can't also drive an apply (no leak).
    this.teardown();
    this.prevSnapshot = prev;
    this.stopped = false;
    this.watcher = this.watchFn(this.path, () => this.onFsEvent());
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  /** Close the watch handle and cancel any queued debounce timer. Shared by stop() and start()'s
   *  re-arm guard; safe to call when nothing is armed. Does NOT touch the `stopped` flag —
   *  callers set that per their own semantics (stop() sets it, start() clears it after). */
  private teardown(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onFsEvent(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onDebounced(), this.debounceMs);
    this.timer.unref?.();
  }

  private onDebounced(): void {
    this.timer = null;
    if (this.stopped) return;
    let next: Settings;
    try {
      next = this.load(this.path);
    } catch (err) {
      // torn file — keep last-known-good, do NOT call apply, do NOT advance prevSnapshot.
      this.log(`settings reload failed, keeping previous: ${msg(err)}`);
      return;
    }
    try {
      this.apply(this.prevSnapshot, next);
      // Advance ONLY after apply returns successfully — so an apply-throw leaves prevSnapshot at
      // last-known-good and the NEXT good change re-diffs against it (the daemon re-converges).
      this.prevSnapshot = next;
    } catch (err) {
      // A throwing apply must NEVER escape this debounce/timer tick (an uncaught throw in a
      // setTimeout callback crashes the daemon process). prevSnapshot deliberately NOT advanced.
      this.log(`settings apply failed, keeping previous: ${msg(err)}`);
    }
  }
}
