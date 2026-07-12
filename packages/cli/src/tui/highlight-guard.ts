/** stderr-suppression guard for the syntax highlighter (Phase 3b Task 7, HARD CONSTRAINT 4).
 *
 *  `cli-highlight`'s underlying highlight.js writes a WARNING to `console.error` when asked to
 *  highlight an unknown/unsupported language. In the raw-mode Ink render surface, ANY stray write to
 *  stderr lands in the middle of the drawn frame and corrupts the display (the cursor is mid-frame,
 *  the escape bookkeeping desyncs). `loadHighlighter` (markdown.ts) already swallows THROWN errors,
 *  but a `console.error` write is not a throw — so we additionally route every highlight call through
 *  `suppressConsoleError`, which swaps `console.error` to a no-op for the duration of the call and
 *  ALWAYS restores it (finally), even if the call throws. */

import { loadHighlighter, type Highlighter } from "./markdown";

/** Run `fn` with `console.error` swapped to a no-op, restoring the original in a `finally` (so a
 *  throw or a normal return both leave `console.error` exactly as it was found). Returns fn's value. */
export function suppressConsoleError<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

/** Load the markdown code-fence highlighter (best-effort, never throws — see `loadHighlighter`) and
 *  wrap it so every highlight call runs under `suppressConsoleError`. The returned `Highlighter` is
 *  safe to call from inside an Ink render pass without risking a display-corrupting stderr write. */
export async function loadSafeHighlighter(): Promise<Highlighter> {
  const highlight = await loadHighlighter();
  return (code: string, lang?: string): string => suppressConsoleError(() => highlight(code, lang));
}
