/**
 * Headless `push_notification` fallback (task-30, push-notification track): when a session has
 * ZERO attached clients (`SessionHub.attachedCount(sessionId) === 0` — no CLI harness, no app
 * window) at the moment the tool fires, the `notification_requested` event that was just
 * persisted/broadcast has nowhere live to render — e.g. a scheduled routine (Phase 5 routines)
 * running fully unattended. This shells out to macOS's own `osascript` so the user still sees
 * SOMETHING, matching CC's own "pushes when a long task finishes or a decision is needed" intent
 * even with nobody attached.
 *
 * ARGV-SAFE (no injection): the AppleScript is a small FIXED `on run argv ... end run` script
 * passed via `-e` lines; `title`/`message` are never interpolated into that script text — they
 * ride as trailing `--` argv items instead, read back inside the script via `item 1 of argv`/
 * `item 2 of argv`. A message containing quotes, semicolons, backticks, or `"` + AppleScript
 * keywords can never break out of the script or execute as AppleScript/shell syntax, because it
 * is never concatenated into a string literal at all — `Bun.spawn`'s argv array is passed
 * straight to `execve`, with no intermediate shell to reinterpret it either.
 *
 * Unsandboxed by design: this runs from the DAEMON's own process (core), never from the agent's
 * sandboxed `bash` tool — `agent/sandbox.ts`'s seatbelt profile (which denies the agent's own
 * shelled-out `osascript` a path to notification_center) has no bearing here, same precedent as
 * `agent/worktree.ts`/`agent/tools/fs-read.ts` calling `git`/`sips` directly, unsandboxed.
 */

/** Injectable spawn seam — tests assert the exact argv without ever shelling out for real
 *  (mirrors `plugins/supervisor.ts`'s own `SpawnFn` injection pattern). */
export type OsascriptSpawnFn = (cmd: string[]) => void;

function defaultOsascriptSpawn(cmd: string[]): void {
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // Best-effort: a missing/broken `osascript` (non-macOS, minimal CI image, etc.) must never
    // fail the tool call itself — push_notification already returned "notification sent" by the
    // time this runs (see engine.ts's `notify` bridge).
  }
}

/** Fires the headless macOS notification. `spawn` defaults to the real `Bun.spawn`-backed
 *  implementation above; tests inject a spy to assert argv shape without touching the OS. */
export function notifyHeadless(title: string, message: string, spawn: OsascriptSpawnFn = defaultOsascriptSpawn): void {
  spawn([
    "osascript",
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e", "end run",
    "--", message, title,
  ]);
}
