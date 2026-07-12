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
