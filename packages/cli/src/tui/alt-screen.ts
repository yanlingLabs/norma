/** Alt-screen pager SPIKE (phase 3b Task 1) — pure escape-sequence writers behind an injectable
 *  sink so tests can assert exact bytes without touching real stdout. `enterAltScreen` switches the
 *  terminal to its alternate screen buffer (`\x1b[?1049h`) — which by itself already leaves the
 *  normal buffer + scrollback untouched underneath (that's the terminal's own save/restore
 *  contract for private mode 1049) — then additionally clears the (now-alternate) buffer and homes
 *  the cursor (`\x1b[2J\x1b[H`) so the pager starts on a clean screen instead of whatever the
 *  alternate buffer last held. `leaveAltScreen` switches back (`\x1b[?1049l`), which restores the
 *  normal buffer's content and cursor position exactly as the terminal saved them on entry. */

export function enterAltScreen(write: (s: string) => void): void {
  write("\x1b[?1049h\x1b[2J\x1b[H");
}

export function leaveAltScreen(write: (s: string) => void): void {
  write("\x1b[?1049l");
}

/** SGR mouse tracking (phase 3c Task 1) — mode 1000 reports button press/release/motion-while-pressed,
 *  mode 1006 switches the REPORTING FORMAT to SGR (`\x1b[<btn;x;yM`/`m`, decimal coordinates with no
 *  upper bound and an unambiguous M/m press/release suffix) instead of the legacy X10 format (which
 *  encodes coordinates as raw bytes offset by 32 and breaks past column/row 223). Scroll-wheel clicks
 *  are reported as synthetic "buttons" 64 (up) / 65 (down) within this same stream — there is no
 *  separate wheel-tracking mode to enable. Both modes are entered/left together since 1006 only
 *  changes 1000's report format and is meaningless on its own. */
export function enableMouseTracking(write: (s: string) => void): void {
  write("\x1b[?1000h\x1b[?1006h");
}

export function disableMouseTracking(write: (s: string) => void): void {
  write("\x1b[?1006l\x1b[?1000l");
}

export type WheelEvent = { dir: "up" | "down" };

// SGR mouse report: CSI < Cb ; Cx ; Cy (M|m). Cb=64 is wheel-up, Cb=65 is wheel-down; any other Cb
// (button press/release/motion) is mouse activity we still want to swallow (so it doesn't get
// misread as literal characters by whatever's driving useInput) but carries no wheel event.
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

export function parseMouseInput(input: string): { wheel?: WheelEvent; isMouse: boolean } {
  const match = SGR_MOUSE_RE.exec(input);
  if (!match) return { isMouse: false };
  const code = Number(match[1]);
  if (code === 64) return { isMouse: true, wheel: { dir: "up" } };
  if (code === 65) return { isMouse: true, wheel: { dir: "down" } };
  return { isMouse: true };
}
