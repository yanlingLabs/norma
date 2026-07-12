/** Pure text+cursor model for the composer (Phase 3c Task 3). Every op takes an `InputState` and
 *  returns a NEW one (no mutation) — `cursor` is always kept in `[0, text.length]` by construction,
 *  so callers never need to clamp themselves. A no-op edit/move (e.g. `left` at cursor 0) returns
 *  the SAME object reference (not just an equal one) so callers can use `Object.is` to detect "no
 *  change happened" cheaply if they ever need to (nothing here relies on that today).
 *
 *  UNICODE LIMITATION (documented, not solved — brief's explicit call): every op indexes `text` by
 *  JS string code unit (`.slice`/`.length`/`[i]`), not by grapheme cluster. Multi-code-unit
 *  characters (astral-plane emoji, combining accents, ZWJ sequences) can have the cursor land
 *  mid-character and `left`/`right`/`backspace`/`del` will split them rather than treating the
 *  cluster atomically. Fixing this would need a full grapheme-segmentation pass (`Intl.Segmenter`)
 *  wired through every op; out of scope for this task. */

export interface InputState {
  text: string;
  cursor: number;
}

/** Whitespace-delimited word boundary, per the brief (not punctuation-aware like some editors). */
const isWhitespace = (ch: string): boolean => /\s/.test(ch);

export function insert(s: InputState, chars: string): InputState {
  if (chars.length === 0) return s;
  const text = s.text.slice(0, s.cursor) + chars + s.text.slice(s.cursor);
  return { text, cursor: s.cursor + chars.length };
}

export function backspace(s: InputState): InputState {
  if (s.cursor === 0) return s;
  const text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
  return { text, cursor: s.cursor - 1 };
}

export function del(s: InputState): InputState {
  if (s.cursor >= s.text.length) return s;
  const text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1);
  return { text, cursor: s.cursor };
}

export function left(s: InputState): InputState {
  return s.cursor === 0 ? s : { ...s, cursor: s.cursor - 1 };
}

export function right(s: InputState): InputState {
  return s.cursor >= s.text.length ? s : { ...s, cursor: s.cursor + 1 };
}

export function home(s: InputState): InputState {
  return s.cursor === 0 ? s : { ...s, cursor: 0 };
}

export function end(s: InputState): InputState {
  return s.cursor >= s.text.length ? s : { ...s, cursor: s.text.length };
}

/** Skips any whitespace immediately left of the cursor, then the word before that — landing on the
 *  first character of that word (or 0, if it's the first word in the text). */
export function wordLeft(s: InputState): InputState {
  let i = s.cursor;
  while (i > 0 && isWhitespace(s.text[i - 1]!)) i--;
  while (i > 0 && !isWhitespace(s.text[i - 1]!)) i--;
  return i === s.cursor ? s : { ...s, cursor: i };
}

/** Skips any whitespace immediately right of the cursor, then the word after that — landing just
 *  past its last character (or `text.length`, if it's the last word in the text). */
export function wordRight(s: InputState): InputState {
  const n = s.text.length;
  let i = s.cursor;
  while (i < n && isWhitespace(s.text[i]!)) i++;
  while (i < n && !isWhitespace(s.text[i]!)) i++;
  return i === s.cursor ? s : { ...s, cursor: i };
}

/** Splits `text` around the cursor for rendering: `at` is the single character the cursor sits ON
 *  (an inverse-video block in the composer), `before`/`after` are the plain text either side. When
 *  the cursor is past the last character (the common "typing at the end" case) `at` is `""` — the
 *  composer renders an inverse SPACE in that case so there's still a visible cursor. */
export function renderWithCursor(s: InputState): { before: string; at: string; after: string } {
  const before = s.text.slice(0, s.cursor);
  const at = s.cursor < s.text.length ? s.text[s.cursor]! : "";
  const after = s.cursor < s.text.length ? s.text.slice(s.cursor + 1) : "";
  return { before, at, after };
}
