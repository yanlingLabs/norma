/** `EventBridge` (Phase 3a Task 6) — the seam between `client.ts`'s connect-time `onEvent` sink and
 *  `<App>`'s React subscription, WITHOUT touching `client.ts` (which the legacy path still shares).
 *
 *  `NormaClient.connect({ onEvent })` fixes its event callback at connect time; it is not an async
 *  iterator. But `<App>` can only subscribe from a `useEffect`, which runs a tick AFTER the first
 *  render — and the session bootstrap (`attach`) can have already replayed events into `onEvent` by
 *  then. So the bridge BUFFERS every event pushed before a subscriber attaches and, on `subscribe`,
 *  flushes that backlog in arrival order before forwarding live events. Nothing replayed is lost.
 *
 *  Single-subscriber by design (one `<App>` per session): `subscribe` replaces the handler and
 *  returns an unsubscribe that drops back to buffering (App's effect-cleanup path). Pure data plumb
 *  — no ink/react import, so `main.ts` can construct the bridge on the shared path without pulling
 *  the Ink module graph onto the non-TTY branch. */

import type { SessionEvent } from "@norma/protocol";

export type EventBridge = {
  push(e: SessionEvent): void;
  subscribe(fn: (e: SessionEvent) => void): () => void;
};

export function makeEventBridge(): EventBridge {
  let handler: ((e: SessionEvent) => void) | null = null;
  const buffer: SessionEvent[] = [];
  return {
    push(e) {
      if (handler) handler(e);
      else buffer.push(e); // no subscriber yet (pre-mount / between subscriptions) — hold in order
    },
    subscribe(fn) {
      handler = fn;
      // Drain the pre-subscribe backlog (attach-replay + anything since) in arrival order, then the
      // caller receives live events directly via push() above.
      while (buffer.length > 0) fn(buffer.shift()!);
      return () => {
        if (handler === fn) handler = null; // back to buffering until the next subscribe
      };
    },
  };
}
