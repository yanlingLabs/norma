// Streaming markdown + syntax-highlight pipeline for the TUI transcript.
// Adapted from the documented behavior of Claude Code's markdown renderer
// (parser choice, token->style mapping, streaming-safe boundary splitting) —
// none of this file's code is copied from that project; it is a fresh
// implementation of the documented rendering rules against `marked` +
// `cli-highlight` + `chalk`.
//
// Chalk determinism: this module owns a *private* `Chalk` instance forced to
// truecolor (`level: 3`) rather than using chalk's ambient default export.
// Chalk's default export auto-detects color support and is level 0 (no
// color) on a non-TTY stream — which is exactly what `bun test` runs under —
// so `chalk.bold("x") === "x"` there and any assertions against it would be
// vacuous. Forcing `level: 3` here means the ANSI output is byte-identical
// in a real terminal, in CI, and under the test runner. Tests build their
// expected strings with a *matching* `new Chalk({ level: 3 })` instance
// (see test/tui/markdown.test.ts) so expectations track this module exactly
// rather than the ambient environment.
import { Chalk } from "chalk";
import { Marked, type Token, type Tokens } from "marked";
import { theme } from "./theme";

const ansi = new Chalk({ level: 3 });

/** U+258E LEFT ONE QUARTER BLOCK — the blockquote bar glyph. */
const BLOCKQUOTE_BAR = "▎";

const md = new Marked();
// Strikethrough is deliberately disabled at the tokenizer level: the model
// uses `~` for "approximately" far more often than it means strikethrough,
// so `~~x~~` should render as plain literal text, never struck through.
md.use({
  tokenizer: {
    del(): undefined {
      return undefined;
    },
  },
});

export type Highlighter = (code: string, lang?: string) => string;

// --- token cache -----------------------------------------------------------
// Module-level cache keyed by raw content, capped at 500 entries so long
// sessions don't grow this unbounded. Eviction is FIFO (oldest-inserted key
// first) via Map's insertion-order iteration, which is sufficient for the
// streaming access pattern (recently-seen full blocks are re-hit far more
// than old ones scroll back into view).
const MAX_CACHE_ENTRIES = 500;
const tokenCache = new Map<string, Token[]>();

function lex(text: string): Token[] {
  const cached = tokenCache.get(text);
  if (cached) return cached;
  const tokens = md.lexer(text) as Token[];
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
  tokenCache.set(text, tokens);
  return tokens;
}

// --- fast path ---------------------------------------------------------------
// Content with no markdown indicators at all skips `marked.lexer` entirely —
// the overwhelmingly common case of a short plain-text reply shouldn't pay
// for a full lex+format pass.
// `|` is included so GFM tables (whose only indicator character may be the
// pipe) never take the fast path and skip table rendering.
const MARKDOWN_INDICATOR_RE = /[*_`#>~[\]|]|^\s*[-+]\s|^\s*\d+[.)]\s/m;

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_INDICATOR_RE.test(text);
}

// --- ordered-list marker formatting ------------------------------------------
// Numeric at depth 0-1, lowercase letters at depth 2, lowercase roman at
// depth 3+, matching the documented behavior.
function toLetter(zeroBasedIndex: number): string {
  let n = zeroBasedIndex;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(value: number): string {
  let n = value;
  let out = "";
  for (const [amount, symbol] of ROMAN_TABLE) {
    while (n >= amount) {
      out += symbol;
      n -= amount;
    }
  }
  return out || "i";
}

function orderedMarker(depth: number, oneBasedIndex: number): string {
  if (depth <= 1) return `${oneBasedIndex}.`;
  if (depth === 2) return `${toLetter(oneBasedIndex - 1)}.`;
  return `${toRoman(oneBasedIndex)}.`;
}

// --- inline formatting --------------------------------------------------------
function formatInlineList(tokens: Token[] | undefined, highlight?: Highlighter): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((token) => formatInline(token, highlight)).join("");
}

function formatInline(token: Token, highlight?: Highlighter): string {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) return formatInlineList(t.tokens, highlight);
      return t.text;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "paragraph":
      // A list item's own text arrives as a "paragraph" token in loose lists
      // (blank-line-separated items); treat it like inline text-with-subtokens
      // so bold/em/codespan inside a loose list item still format correctly.
      return formatInlineList((token as Tokens.Paragraph).tokens, highlight);
    case "strong":
      return ansi.bold(formatInlineList((token as Tokens.Strong).tokens, highlight));
    case "em":
      return ansi.italic(formatInlineList((token as Tokens.Em).tokens, highlight));
    case "codespan":
      return ansi.hex(theme.permission)((token as Tokens.Codespan).text);
    case "del": {
      // Should not occur — the tokenizer is disabled above — but degrade to
      // plain (non-struck-through) inline text if it ever does.
      return formatInlineList((token as Tokens.Del).tokens, highlight);
    }
    case "br":
      return "\n";
    case "link":
    case "image": {
      const l = token as Tokens.Link | Tokens.Image;
      const inner = formatInlineList(l.tokens, highlight);
      return inner || l.text;
    }
    case "html":
      return (token as Tokens.Tag).raw;
    default: {
      const generic = token as Tokens.Generic;
      return typeof generic.text === "string" ? generic.text : "";
    }
  }
}

// --- block formatting ----------------------------------------------------------
function formatBlock(token: Token, depth: number, highlight?: Highlighter): string {
  switch (token.type) {
    case "space":
      return "";
    case "paragraph":
      return formatInlineList((token as Tokens.Paragraph).tokens, highlight);
    case "heading": {
      const h = token as Tokens.Heading;
      const content = formatInlineList(h.tokens, highlight);
      return h.depth === 1 ? ansi.bold.italic.underline(content) : ansi.bold(content);
    }
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      const inner = bq.tokens.map((t) => formatBlock(t, depth, highlight)).join("\n");
      return inner
        .split("\n")
        .map((line) => `${ansi.dim(BLOCKQUOTE_BAR)} ${ansi.italic(line)}`)
        .join("\n");
    }
    case "code": {
      const c = token as Tokens.Code;
      if (highlight) return highlight(c.text, c.lang);
      return c.text;
    }
    case "list":
      return formatList(token as Tokens.List, depth, highlight);
    case "table":
      return formatTable(token as Tokens.Table);
    case "hr":
      return ansi.dim("───");
    default: {
      const generic = token as Tokens.Generic;
      return typeof generic.text === "string" ? generic.text : "";
    }
  }
}

function formatList(list: Tokens.List, depth: number, highlight?: Highlighter): string {
  const indent = "  ".repeat(depth);
  const start = typeof list.start === "number" ? list.start : 1;
  const lines: string[] = [];

  list.items.forEach((item, index) => {
    const marker = list.ordered ? orderedMarker(depth, start + index) : "-";

    // An item's own tokens mix inline content (text/paragraph, possibly with
    // embedded soft-break newlines) with nested "list" block tokens. Nested
    // lists must start on their own line — they are formatted (and indented)
    // independently by the recursive formatList(_, depth + 1, _) call below
    // — so they are collected separately rather than string-concatenated
    // onto the item's own text.
    let ownText = "";
    const nestedBlocks: string[] = [];
    for (const t of item.tokens) {
      if (t.type === "list") {
        nestedBlocks.push(formatBlock(t, depth + 1, highlight));
      } else {
        ownText += formatInline(t, highlight);
      }
    }

    const ownLines = ownText.split("\n");
    lines.push(`${indent}${marker} ${ownLines[0] ?? ""}`);
    for (let i = 1; i < ownLines.length; i++) {
      lines.push(`${indent}  ${ownLines[i]}`);
    }
    for (const block of nestedBlocks) {
      lines.push(...block.split("\n"));
    }
  });

  return lines.join("\n");
}

// Simple ASCII table for GFM tables: column widths from the widest cell per
// column (left-aligned, no wrapping — long cells just widen their column),
// header row bold, `─┼─` separator row beneath, plain rows after. This is the
// string-context fallback; a reflow-aware React table component is future
// work. Cells use their plain `.text` (not inline-formatted) so column-width
// math stays trivially correct — ANSI escapes inside a cell would break the
// visible-width padding.
function formatTable(table: Tokens.Table): string {
  const headerTexts = table.header.map((cell) => cell.text);
  const rowTexts = table.rows.map((row) => row.map((cell) => cell.text));

  const widths = headerTexts.map((headerText, col) => {
    let width = headerText.length;
    for (const row of rowTexts) {
      const cell = row[col];
      if (cell !== undefined && cell.length > width) width = cell.length;
    }
    return width;
  });

  const pad = (text: string, width: number): string =>
    text + " ".repeat(Math.max(0, width - text.length));

  const headerLine = headerTexts
    .map((headerText, col) => ansi.bold(pad(headerText, widths[col] ?? headerText.length)))
    .join(" | ");
  const separatorLine = widths.map((width) => "─".repeat(width)).join("─┼─");
  const bodyLines = rowTexts.map((row) =>
    row.map((cell, col) => pad(cell, widths[col] ?? cell.length)).join(" | "),
  );

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

// --- public API ------------------------------------------------------------

/**
 * Render `text` (a complete markdown string, or a stable/complete fragment
 * of one) to an ANSI string using this module's theme + chalk instance.
 * `highlight` is an optional syntax highlighter for fenced code blocks
 * (see `loadHighlighter`); without one, fenced blocks render as plain text.
 */
export function renderMarkdown(text: string, highlight?: Highlighter): string {
  if (!looksLikeMarkdown(text)) return text;
  const tokens = lex(text);
  return tokens
    .filter((t) => t.type !== "space")
    .map((t) => formatBlock(t, 0, highlight))
    .join("\n\n");
}

/**
 * Split a growing (streaming) markdown string at the last stable top-level
 * block boundary. `stable` is safe to render once and memoize; `tail` is the
 * still-growing suffix that must be re-parsed on every delta. The split is
 * monotonic: as `text` grows by appending characters, `stable` only grows
 * (never shrinks, never gets rewritten out from under an already-rendered
 * prefix).
 *
 * Implementation: `marked.lexer`'s tokens reconstruct `text` exactly when
 * their `.raw` fields are concatenated, so treating every token except the
 * last as "stable" and taking the textual remainder as `tail` is an exact,
 * lossless split — no re-serialization/formatting involved. The last token
 * is always considered provisional because streaming can still append to it
 * (unclosed fences included: marked treats an unterminated fence as a single
 * `code` token, so it stays whole in `tail` rather than being torn apart).
 */
export function splitStableBoundary(text: string): { stable: string; tail: string } {
  if (text.length === 0) return { stable: "", tail: "" };
  const tokens = lex(text);
  if (tokens.length <= 1) return { stable: "", tail: text };

  const stableTokens = tokens.slice(0, -1);
  const stableLength = stableTokens.reduce((sum, t) => sum + t.raw.length, 0);
  return { stable: text.slice(0, stableLength), tail: text.slice(stableLength) };
}

/**
 * Lazily load the `cli-highlight` syntax highlighter. Never throws or
 * rejects: an import failure degrades to the identity function, and a
 * per-call failure (e.g. an unsupported/unknown language at call time)
 * degrades that single call to plain, unhighlighted text. Highlighting is
 * strictly best-effort — it must never crash a render.
 */
export async function loadHighlighter(): Promise<Highlighter> {
  try {
    const mod = await import("cli-highlight");
    const highlightFn = mod.highlight;
    return (code: string, lang?: string): string => {
      try {
        return highlightFn(code, lang ? { language: lang } : undefined);
      } catch {
        return code;
      }
    };
  } catch {
    return (code: string): string => code;
  }
}
