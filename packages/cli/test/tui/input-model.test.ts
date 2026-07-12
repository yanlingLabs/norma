import { describe, expect, test } from "bun:test";
import {
  backspace,
  del,
  end,
  home,
  insert,
  left,
  renderWithCursor,
  right,
  wordLeft,
  wordRight,
  type InputState,
} from "../../src/tui/input-model";

const s = (text: string, cursor: number): InputState => ({ text, cursor });

describe("input-model", () => {
  describe("insert", () => {
    test("inserts at the cursor, moving it past the inserted text", () => {
      expect(insert(s("ac", 1), "b")).toEqual({ text: "abc", cursor: 2 });
    });
    test("inserts a whole pasted string as one op", () => {
      expect(insert(s("", 0), "hello")).toEqual({ text: "hello", cursor: 5 });
    });
    test("empty insert is a no-op (same state)", () => {
      const state = s("ab", 1);
      expect(insert(state, "")).toBe(state);
    });
    test("inserts at the end", () => {
      expect(insert(s("ab", 2), "c")).toEqual({ text: "abc", cursor: 3 });
    });
    test("inserts at the start", () => {
      expect(insert(s("bc", 0), "a")).toEqual({ text: "abc", cursor: 1 });
    });
  });

  describe("backspace", () => {
    test("removes the char before the cursor", () => {
      expect(backspace(s("abc", 3))).toEqual({ text: "ab", cursor: 2 });
    });
    test("removes a mid-text char", () => {
      expect(backspace(s("abc", 2))).toEqual({ text: "ac", cursor: 1 });
    });
    test("no-op at cursor 0", () => {
      const state = s("abc", 0);
      expect(backspace(state)).toBe(state);
    });
    test("no-op on empty text", () => {
      const state = s("", 0);
      expect(backspace(state)).toBe(state);
    });
  });

  describe("del", () => {
    test("removes the char at the cursor, cursor unchanged", () => {
      expect(del(s("abc", 0))).toEqual({ text: "bc", cursor: 0 });
    });
    test("removes a mid-text char", () => {
      expect(del(s("abc", 1))).toEqual({ text: "ac", cursor: 1 });
    });
    test("no-op at end of text", () => {
      const state = s("abc", 3);
      expect(del(state)).toBe(state);
    });
    test("no-op on empty text", () => {
      const state = s("", 0);
      expect(del(state)).toBe(state);
    });
  });

  describe("left/right", () => {
    test("left moves back one", () => {
      expect(left(s("abc", 2))).toEqual({ text: "abc", cursor: 1 });
    });
    test("left no-op at 0", () => {
      const state = s("abc", 0);
      expect(left(state)).toBe(state);
    });
    test("right moves forward one", () => {
      expect(right(s("abc", 1))).toEqual({ text: "abc", cursor: 2 });
    });
    test("right no-op at end", () => {
      const state = s("abc", 3);
      expect(right(state)).toBe(state);
    });
  });

  describe("home/end", () => {
    test("home jumps to 0", () => {
      expect(home(s("abc", 2))).toEqual({ text: "abc", cursor: 0 });
    });
    test("home no-op already at 0", () => {
      const state = s("abc", 0);
      expect(home(state)).toBe(state);
    });
    test("end jumps to text.length", () => {
      expect(end(s("abc", 1))).toEqual({ text: "abc", cursor: 3 });
    });
    test("end no-op already at end", () => {
      const state = s("abc", 3);
      expect(end(state)).toBe(state);
    });
  });

  describe("wordLeft/wordRight (whitespace-delimited)", () => {
    test("wordLeft from end of last word lands at its start", () => {
      expect(wordLeft(s("foo bar", 7))).toEqual({ text: "foo bar", cursor: 4 });
    });
    test("wordLeft skips trailing whitespace before jumping", () => {
      expect(wordLeft(s("foo bar   ", 10))).toEqual({ text: "foo bar   ", cursor: 4 });
    });
    test("wordLeft from mid-word lands at that word's start", () => {
      expect(wordLeft(s("foo bar", 5))).toEqual({ text: "foo bar", cursor: 4 });
    });
    test("wordLeft from the first word lands at 0", () => {
      expect(wordLeft(s("foo bar", 2))).toEqual({ text: "foo bar", cursor: 0 });
    });
    test("wordLeft no-op at 0", () => {
      const state = s("foo bar", 0);
      expect(wordLeft(state)).toBe(state);
    });
    test("wordRight from start of first word lands after it", () => {
      expect(wordRight(s("foo bar", 0))).toEqual({ text: "foo bar", cursor: 3 });
    });
    test("wordRight skips leading whitespace before jumping", () => {
      expect(wordRight(s("foo   bar", 3))).toEqual({ text: "foo   bar", cursor: 9 });
    });
    test("wordRight from the last word lands at text.length", () => {
      expect(wordRight(s("foo bar", 5))).toEqual({ text: "foo bar", cursor: 7 });
    });
    test("wordRight no-op at end", () => {
      const state = s("foo bar", 7);
      expect(wordRight(state)).toBe(state);
    });
  });

  describe("renderWithCursor", () => {
    test("splits before/at/after around a mid-text cursor", () => {
      expect(renderWithCursor(s("abc", 1))).toEqual({ before: "a", at: "b", after: "c" });
    });
    test("at is '' when cursor is past the last character", () => {
      expect(renderWithCursor(s("abc", 3))).toEqual({ before: "abc", at: "", after: "" });
    });
    test("empty text: everything is ''", () => {
      expect(renderWithCursor(s("", 0))).toEqual({ before: "", at: "", after: "" });
    });
    test("cursor at 0 on non-empty text", () => {
      expect(renderWithCursor(s("abc", 0))).toEqual({ before: "", at: "a", after: "bc" });
    });
  });
});
