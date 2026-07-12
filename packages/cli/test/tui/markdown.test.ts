import { describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { renderMarkdown, splitStableBoundary, loadHighlighter } from "../../src/tui/markdown";
import { theme } from "../../src/tui/theme";

// This suite intentionally builds its own `Chalk({ level: 3 })` instance
// rather than relying on the ambient `chalk` default export. Chalk auto
// detects color support and defaults to level 0 (no ANSI at all) on a
// non-TTY stream — which is what `bun test` runs under — so `chalk.bold("x")
// === "x"` there and any assertion built from the ambient export would be
// vacuous. markdown.ts forces `level: 3` internally for exactly this reason;
// mirroring that here keeps expectations tied to markdown.ts's real output
// instead of to whatever terminal happens to run the suite.
const ansi = new Chalk({ level: 3 });

describe("markdown.ts — renderMarkdown inline styles (a)", () => {
  test("bold, italic, and inline code get their theme styles", () => {
    const out = renderMarkdown("**bold** and *em* and `code`");
    expect(out).toContain(ansi.bold("bold"));
    expect(out).toContain(ansi.italic("em"));
    expect(out).toContain(ansi.hex(theme.permission)("code"));
  });
});

describe("markdown.ts — headings (b)", () => {
  test("depth 1 is bold+italic+underline", () => {
    expect(renderMarkdown("# Title")).toBe(ansi.bold.italic.underline("Title"));
  });

  test("depth 2 and depth 3 are bold only", () => {
    expect(renderMarkdown("## Sub")).toBe(ansi.bold("Sub"));
    expect(renderMarkdown("### SubSub")).toBe(ansi.bold("SubSub"));
  });
});

describe("markdown.ts — blockquote (c)", () => {
  test("each line is prefixed with a dim bar and italicized", () => {
    const out = renderMarkdown("> line one\n> line two");
    const expected = [`${ansi.dim("▎")} ${ansi.italic("line one")}`, `${ansi.dim("▎")} ${ansi.italic("line two")}`].join(
      "\n",
    );
    expect(out).toBe(expected);
  });
});

describe("markdown.ts — nested lists (d)", () => {
  test("unordered lists use `-` bullets with 2-space indent per nesting level", () => {
    const out = renderMarkdown("- item1\n- item2\n  - nested\n");
    expect(out.split("\n")).toEqual(["- item1", "- item2", "  - nested"]);
  });

  test("ordered lists: numeric at depth 0, numeric at depth 1, letters at depth 2, 2-space indent per level", () => {
    const out = renderMarkdown("1. top\n   1. mid\n      1. deep\n");
    expect(out.split("\n")).toEqual(["1. top", "  1. mid", "    a. deep"]);
  });

  test("ordered lists go lowercase roman at depth 3+", () => {
    const out = renderMarkdown("1. l0\n   1. l1\n      1. l2\n         1. l3\n");
    expect(out.split("\n")).toEqual(["1. l0", "  1. l1", "    a. l2", "      i. l3"]);
  });
});

describe("markdown.ts — strikethrough disabled (e)", () => {
  test("~~x~~ is NOT struck through; renders as literal text", () => {
    const out = renderMarkdown("~~strike~~ approx ~5~");
    expect(out).toBe("~~strike~~ approx ~5~");
  });
});

describe("markdown.ts — fenced code blocks (f)", () => {
  test("without a highlighter, the code is preserved verbatim", () => {
    const code = "const x = 1;\nconst y = 2;";
    const out = renderMarkdown("```js\n" + code + "\n```");
    expect(out).toBe(code);
  });

  test("with a highlighter, its output is embedded", () => {
    const code = "const x = 1;";
    const fakeHighlight = (c: string, lang?: string) => `<<${lang}:${c}>>`;
    const out = renderMarkdown("```js\n" + code + "\n```", fakeHighlight);
    expect(out).toBe(`<<js:${code}>>`);
  });
});

describe("markdown.ts — splitStableBoundary (g)", () => {
  test("mid-paragraph text with no completed block boundary: everything is tail", () => {
    const text = "just some mid paragraph text with no boundary yet";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("");
    expect(tail).toBe(text);
  });

  test("two complete paragraphs + a partial third: first two stable, third is tail", () => {
    const text = "First paragraph complete.\n\nSecond paragraph complete.\n\nThird partial para";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("First paragraph complete.\n\nSecond paragraph complete.\n\n");
    expect(tail).toBe("Third partial para");
    expect(stable + tail).toBe(text);
  });

  test("an unclosed fenced code block stays entirely in the tail", () => {
    const text = "Intro paragraph.\n\n```js\nconst x = 1;";
    const { stable, tail } = splitStableBoundary(text);
    expect(stable).toBe("Intro paragraph.\n\n");
    expect(tail).toBe("```js\nconst x = 1;");
    expect(stable + tail).toBe(text);
  });

  test("boundary only advances as text grows (monotonic)", () => {
    const base = "P1.\n\nP2.\n\nGrowing partial";
    const grown = base + " tail that keeps extending the same open paragraph";
    const a = splitStableBoundary(base).stable;
    const b = splitStableBoundary(grown).stable;
    expect(a).toBe("P1.\n\nP2.\n\n");
    expect(b.startsWith(a)).toBe(true);
  });
});

describe("markdown.ts — no-markdown fast path (h)", () => {
  test("plain text with no markdown indicators returns unchanged", () => {
    const text = "This is just plain text without any markdown indicators at all.";
    expect(renderMarkdown(text)).toBe(text);
  });
});

describe("markdown.ts — loadHighlighter", () => {
  test("resolves to a working highlighter for a real language", async () => {
    const highlight = await loadHighlighter();
    const out = highlight("const x = 1;", "javascript");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("never throws: an unknown language degrades to plain text instead of crashing", async () => {
    const highlight = await loadHighlighter();
    const code = "some code";
    expect(() => highlight(code, "not-a-real-language-xyz")).not.toThrow();
    expect(highlight(code, "not-a-real-language-xyz")).toBe(code);
  });
});
