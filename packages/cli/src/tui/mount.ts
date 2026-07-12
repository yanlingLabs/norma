/** `mountTui` (Phase 3a Task 6; Phase 3c Task 4 — the FULLSCREEN alt-screen boundary). main.ts calls
 *  this once, after the session bootstrap, on the Ink branch.
 *
 *  HEADLESS SAFETY NET: if `process.stdout.isTTY` is falsy it returns a resolved no-op handle WITHOUT
 *  calling Ink's `render` OR writing any escape — a non-TTY invocation that somehow reaches here (it
 *  should be double-guarded by main.ts's `chat && isTTY` too) never touches the terminal and stays
 *  byte-identical to the legacy headless path.
 *
 *  ALT-SCREEN LIFECYCLE (HARD CONSTRAINT 3, all through the injected `write` sink so tests assert the
 *  exact byte order without touching a real terminal):
 *    enterAltScreen → enableMouseTracking → render(<App>) …  (interactive)
 *    … on exit request: disableMouseTracking → instance.unmount() → await waitUntilExit() → leaveAltScreen
 *  The App is rendered onto a BSU/ESU synchronized-update stdout proxy (`makeSyncStdout`) with
 *  `exitOnCtrlC: false` — the App itself owns quitting now (TODO(T5): a temporary single ctrl+C press
 *  calls `onExitRequest`, wired below to the teardown; T5 replaces it with the double-press flow and
 *  prints the resume hint in main.ts). */

import React from "react";
import { render as inkRender } from "ink";
import { App, type AppClient } from "./app";
import { makeSyncStdout } from "./sync-stdout";
import { enterAltScreen, leaveAltScreen, enableMouseTracking, disableMouseTracking } from "./alt-screen";
import type { EventBridge } from "./event-bridge";
import type { ApprovalPolicy } from "@norma/protocol";

export interface MountOpts {
  client: AppClient;
  bridge: EventBridge;
  sessionId: string;
  cwd: string;
  initialPolicy: ApprovalPolicy;
  version: string; // CLI version — welcome banner (packages/cli/package.json)
  model: string; // resolved provider model — welcome banner (settings.provider.model)
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
}

/** A structural view of Ink's `render` — only `unmount`/`waitUntilExit` are used here, so tests can
 *  inject a spy returning a controllable stub. Ink's real `render` (returns the full `Instance`)
 *  satisfies it. */
export type RenderInstance = { unmount(): void; waitUntilExit(): Promise<void> };
export type RenderLike = (node: React.ReactElement, options?: unknown) => RenderInstance;

export function mountTui(
  opts: MountOpts,
  renderImpl: RenderLike = inkRender as unknown as RenderLike,
  write: (s: string) => void = (s) => { process.stdout.write(s); },
): TuiHandle {
  if (!process.stdout.isTTY) {
    // Non-TTY: never render, never write an escape — hand back an already-resolved handle so the
    // caller's `await handle.waitUntilExit()` returns immediately (headless untouched).
    return { waitUntilExit: () => Promise.resolve() };
  }

  enterAltScreen(write);
  enableMouseTracking(write);

  let instance: RenderInstance;
  let requested = false;
  const onExitRequest = (): void => {
    if (requested) return; // idempotent — repeated presses collapse into the one teardown
    requested = true;
    disableMouseTracking(write);
    instance.unmount();
  };

  instance = renderImpl(
    React.createElement(App, {
      client: opts.client,
      bridge: opts.bridge,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      initialPolicy: opts.initialPolicy,
      version: opts.version,
      model: opts.model,
      onExitRequest,
    }),
    { stdout: makeSyncStdout(process.stdout), exitOnCtrlC: false },
  );

  return {
    waitUntilExit: async () => {
      // Block until Ink unmounts (via onExitRequest, or any other path), THEN write the leave escape
      // last — completing the HARD CONSTRAINT 3 order: disableMouseTracking → unmount →
      // waitUntilExit → leaveAltScreen. If Ink unmounted by a path that didn't go through
      // onExitRequest, mouse tracking hasn't been disabled yet, so do it here first.
      await instance.waitUntilExit();
      if (!requested) disableMouseTracking(write);
      leaveAltScreen(write);
    },
  };
}
