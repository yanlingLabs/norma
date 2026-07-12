/** `viewport.ts` (Phase 3c Task 2) — pure scroll-state math for the windowed transcript line log.
 *  No Ink, no React, no side effects: `ViewportState` is plain data and every function here is a
 *  total, deterministic transform over it + the current line count / view height. The App (Task 4)
 *  owns the actual `ViewportState` and feeds it `flatten-blocks.ts`'s output each render.
 *
 *  "stick" is the auto-follow flag: while `stick` is true, `viewportSlice` ALWAYS recomputes
 *  `scrollTop` fresh from the CURRENT line count (`max(0, len - viewH)`) on every call — that is
 *  what makes the window follow transcript growth without any explicit scroll action being
 *  replayed. The moment the user scrolls up (any negative `scrollBy` delta), `stick` clears so
 *  their position holds even as more content streams in; scrolling back down to the bottom
 *  re-arms it. This mirrors the familiar terminal/chat-app "stick to bottom unless the user
 *  scrolled away" behavior. */

export interface ViewportState {
  scrollTop: number;
  stick: boolean;
}

/** The largest legal `scrollTop` for `len` lines in a `viewH`-tall viewport — never negative (a
 *  transcript shorter than the viewport has nowhere to scroll). */
function maxScrollTop(len: number, viewH: number): number {
  return Math.max(0, len - viewH);
}

/** Render-time slice: clamps/derives `scrollTop` and returns the visible window alongside the
 *  (possibly corrected) `ViewportState` the caller should keep. `stick` short-circuits the stored
 *  `scrollTop` entirely — it is recomputed as `max(0, len - viewH)` every call, so growth is
 *  followed automatically. When not stuck, the stored `scrollTop` is clamped into
 *  `[0, max(0, len - viewH)]` (guards against `len` ever shrinking under a previously-valid offset,
 *  and against an out-of-range value reaching this function at all). Returns the SAME `vp`
 *  reference when nothing changed (cheap reference-equality check for callers that memoize on it,
 *  matching this codebase's `state.ts` convention of only allocating a new object on real change). */
export function viewportSlice(
  lines: string[],
  vp: ViewportState,
  viewH: number,
): { visible: string[]; vp: ViewportState } {
  const max = maxScrollTop(lines.length, viewH);
  const scrollTop = vp.stick ? max : Math.min(Math.max(0, vp.scrollTop), max);
  const nextVp = scrollTop === vp.scrollTop ? vp : { ...vp, scrollTop };
  return { visible: lines.slice(scrollTop, scrollTop + viewH), vp: nextVp };
}

/** One manual scroll step (e.g. an arrow-key press). Clamps the result into
 *  `[0, max(0, len - viewH)]` unconditionally. Sticking rules (brief, exact):
 *   - ANY upward delta (`delta < 0`) unconditionally sets `stick: false` — even in the degenerate
 *     case where the clamped target lands back on `max` (e.g. `len <= viewH`, so `max === 0` and
 *     there is nowhere to actually move): the user's intent to scroll away from the bottom is what
 *     matters, not whether the clamp happened to leave them exactly at the bottom line.
 *   - A non-negative delta (including `0`, a no-op re-clamp) re-sticks exactly when the clamped
 *     target reaches `max` — this is how scrolling all the way back down re-arms auto-follow. */
export function scrollBy(vp: ViewportState, delta: number, len: number, viewH: number): ViewportState {
  const max = maxScrollTop(len, viewH);
  const target = Math.min(Math.max(0, vp.scrollTop + delta), max);
  if (delta < 0) return { scrollTop: target, stick: false };
  return { scrollTop: target, stick: target >= max };
}

/** Jump to the top. Always unstuck (there is nothing "below" the top to keep following) and always
 *  `scrollTop: 0` regardless of the input state — `vp` is accepted only for call-shape symmetry
 *  with `scrollBy`/`scrollToBottom`; none of its fields feed the result. */
export function scrollToTop(_vp: ViewportState): ViewportState {
  return { scrollTop: 0, stick: false };
}

/** Jump to (and stay stuck to) the bottom. `scrollTop: 0` here is an inert placeholder — because
 *  `stick` is true, the next `viewportSlice` call recomputes the real bottom offset from whatever
 *  the current line count is, so no length/viewH context is needed at this call site. */
export function scrollToBottom(): ViewportState {
  return { scrollTop: 0, stick: true };
}
