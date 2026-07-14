import fs from "node:fs";
import type { Settings } from "./settings";

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
    this.prevSnapshot = prev;
    this.stopped = false;
    this.watcher = this.watchFn(this.path, () => this.onFsEvent());
  }

  stop(): void {
    this.stopped = true;
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
      this.log(`settings reload failed, keeping previous: ${(err as Error).message}`);
      return;
    }
    const prev = this.prevSnapshot;
    this.prevSnapshot = next;
    this.apply(prev, next);
  }
}
