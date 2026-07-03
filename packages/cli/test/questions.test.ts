import { describe, expect, test } from "bun:test";
import { isOtherChoice, parseQuestionAnswer } from "../src/questions";

describe("parseQuestionAnswer", () => {
  test("number → label; comma numbers → joined; free text passthrough; whitespace trimmed", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("2", opts, false)).toBe("Osprey");
    expect(parseQuestionAnswer("1,3", opts, true)).toBe("Falcon, Heron");
    expect(parseQuestionAnswer(" 2 ", opts, false)).toBe("Osprey");
    expect(parseQuestionAnswer("something else", opts, false)).toBe("something else"); // free text (the "Other" path)
    expect(parseQuestionAnswer("9", opts, false)).toBe("9"); // out-of-range number → treated as free text
  });

  test("comma numbers only join when multiSelect is true", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    // multiSelect false: comma path is never taken, whole string is treated as one token → not a valid number → free text verbatim
    expect(parseQuestionAnswer("1,3", opts, false)).toBe("1,3");
  });

  test("multiSelect with a mix of valid/invalid tokens falls back to free text verbatim", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("1,9", opts, true)).toBe("1,9");
    expect(parseQuestionAnswer("1,abc", opts, true)).toBe("1,abc");
  });

  test("the 'Other' index (options.length + 1) is out-of-range → free text (raw fallback, pre-isOtherChoice check)", () => {
    const opts = ["Falcon", "Osprey", "Heron"];
    expect(parseQuestionAnswer("4", opts, false)).toBe("4");
  });
});

describe("isOtherChoice", () => {
  test("matches exactly the Other menu number (options.length + 1)", () => {
    expect(isOtherChoice("4", 3)).toBe(true);
    expect(isOtherChoice(" 4 ", 3)).toBe(true); // whitespace trimmed
  });

  test("does not match a real option number, a different out-of-range number, or free text", () => {
    expect(isOtherChoice("1", 3)).toBe(false);
    expect(isOtherChoice("3", 3)).toBe(false); // last real option, not Other
    expect(isOtherChoice("9", 3)).toBe(false); // out-of-range but not the Other index
    expect(isOtherChoice("something else", 3)).toBe(false);
    expect(isOtherChoice("4,1", 3)).toBe(false); // comma list, not a bare Other selection
  });
});
