/** `mountTui` (Phase 3a Task 6) — the boundary that hands the interactive TTY to Ink. main.ts calls
 *  this once, after the session bootstrap, on the Ink branch.
 *
 *  HEADLESS SAFETY NET: if `process.stdout.isTTY` is falsy it returns a resolved no-op handle
 *  WITHOUT calling Ink's `render` — so a non-TTY invocation that somehow reaches here (it should be
 *  double-guarded by main.ts's `chat && isTTY` condition too) never touches the terminal and stays
 *  byte-identical to the legacy headless path. The renderer is injectable so the guard is directly
 *  unit-testable both ways without spinning a real Ink instance. Ink's default Ctrl+C exit stands. */

import React from "react";
import { render as inkRender } from "ink";
import { App, type AppClient } from "./app";
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

/** A structural view of Ink's `render` — only `waitUntilExit` is used here, so tests can inject a
 *  spy that returns a stub handle. Ink's real `render` (returns the full `Instance`) satisfies it. */
export type RenderLike = (node: React.ReactElement) => { waitUntilExit(): Promise<void> };

export function mountTui(opts: MountOpts, renderImpl: RenderLike = inkRender): TuiHandle {
  if (!process.stdout.isTTY) {
    // Non-TTY: never render — hand back an already-resolved handle so the caller's
    // `await handle.waitUntilExit()` returns immediately (headless untouched).
    return { waitUntilExit: () => Promise.resolve() };
  }
  const { waitUntilExit } = renderImpl(
    React.createElement(App, {
      client: opts.client,
      bridge: opts.bridge,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      initialPolicy: opts.initialPolicy,
      version: opts.version,
      model: opts.model,
    }),
  );
  return { waitUntilExit };
}
