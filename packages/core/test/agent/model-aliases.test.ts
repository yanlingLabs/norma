import { describe, expect, test } from "bun:test";
import { deriveModelAliases, resolveModelAlias } from "../../src/agent/model-aliases";

const SOL_TERRA_LUNA = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

describe("resolveModelAlias", () => {
  test("resolves a short alias to the unique known id ending with -<alias>", () => {
    expect(resolveModelAlias("sol", SOL_TERRA_LUNA)).toBe("gpt-5.6-sol");
    expect(resolveModelAlias("terra", SOL_TERRA_LUNA)).toBe("gpt-5.6-terra");
    expect(resolveModelAlias("luna", SOL_TERRA_LUNA)).toBe("gpt-5.6-luna");
  });

  test("a full id passed through is returned unchanged (no alias resolution needed)", () => {
    expect(resolveModelAlias("gpt-5.6-sol", SOL_TERRA_LUNA)).toBe("gpt-5.6-sol");
  });

  test("an unknown string with no matching suffix is returned unchanged", () => {
    expect(resolveModelAlias("banana", SOL_TERRA_LUNA)).toBe("banana");
  });

  test("ambiguity safety: two known ids sharing the same trailing suffix never resolve — returned unchanged", () => {
    const ambiguous = ["vendor-a-sol", "vendor-b-sol"];
    expect(resolveModelAlias("sol", ambiguous)).toBe("sol");
  });

  test("empty knownIds (provider can't enumerate) never resolves anything", () => {
    expect(resolveModelAlias("sol", [])).toBe("sol");
  });
});

describe("deriveModelAliases", () => {
  test("derives sol/terra/luna from the gpt-5.6 trio", () => {
    expect(deriveModelAliases(SOL_TERRA_LUNA).sort()).toEqual(["luna", "sol", "terra"]);
  });

  test("excludes an ambiguous suffix shared by two ids", () => {
    expect(deriveModelAliases(["vendor-a-sol", "vendor-b-sol", "gpt-5.6-terra"])).toEqual(["terra"]);
  });

  test("ids with no dash contribute no alias", () => {
    expect(deriveModelAliases(["fake1", "fake2"])).toEqual([]);
  });

  test("empty input yields no aliases", () => {
    expect(deriveModelAliases([])).toEqual([]);
  });
});
