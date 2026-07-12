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
 *  `exitOnCtrlC: false` — the App itself owns quitting (Task 5's double-ctrl+C/ctrl+D flow calls
 *  `onExitRequest`, wired below to the teardown; main.ts prints the dim "resume this session with…"
 *  hint itself, AFTER `waitUntilExit()` resolves — i.e. after `leaveAltScreen` above has already run,
 *  landing the hint in the NORMAL buffer, never the alt screen).
 *
 *  RESUME REPLAY (Task 5): `resumeTargetSeq` is a passthrough — main.ts sets it (to the seq its own
 *  `attach(sessionId, 0)` call returned) ONLY on the `norma resume <id>` Ink route; every other route
 *  (fresh session, legacy/NORMA_LEGACY_CLI chat resume, non-TTY) leaves it `undefined`, and `<App>`'s
 *  behavior with `undefined` is exactly today's (see app.tsx's RESUME REPLAY doc comment). */

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
  /** Task 5 resume replay — see the module doc comment. Passed straight through to `<App>`. */
  resumeTargetSeq?: number;
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
      resumeTargetSeq: opts.resumeTargetSeq,
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
