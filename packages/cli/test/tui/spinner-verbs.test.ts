import { describe, expect, test } from "bun:test";
import { pickVerb, SPINNER_VERBS, TURN_VERBS } from "../../src/tui/spinner-verbs";

describe("spinner-verbs.ts", () => {
  test("SPINNER_VERBS is non-empty and every entry is a gerund ('...ing')", () => {
    expect(SPINNER_VERBS.length).toBeGreaterThan(0);
    for (const verb of SPINNER_VERBS) {
      expect(verb.endsWith("ing")).toBe(true);
    }
  });

  test("SPINNER_VERBS has roughly 50 entries and no duplicates", () => {
    expect(SPINNER_VERBS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SPINNER_VERBS).size).toBe(SPINNER_VERBS.length);
  });

  test("TURN_VERBS is non-empty and includes 'Worked'", () => {
    expect(TURN_VERBS.length).toBeGreaterThan(0);
    expect(TURN_VERBS).toContain("Worked");
  });

  test("TURN_VERBS has roughly 8 entries and no duplicates", () => {
    expect(TURN_VERBS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(TURN_VERBS).size).toBe(TURN_VERBS.length);
  });

  test("pickVerb is deterministic: equal seeds yield equal results", () => {
    expect(pickVerb(SPINNER_VERBS, 42)).toBe(pickVerb(SPINNER_VERBS, 42));
    expect(pickVerb(TURN_VERBS, 1_700_000_000_123)).toBe(pickVerb(TURN_VERBS, 1_700_000_000_123));
  });

  test("pickVerb always returns an element of the supplied list", () => {
    for (const seed of [0, 1, -1, 7, -7, 999_999, -999_999]) {
      expect(SPINNER_VERBS).toContain(pickVerb(SPINNER_VERBS, seed));
      expect(TURN_VERBS).toContain(pickVerb(TURN_VERBS, seed));
    }
  });

  test("pickVerb handles negative seeds without throwing", () => {
    expect(() => pickVerb(SPINNER_VERBS, -12345)).not.toThrow();
  });
});
