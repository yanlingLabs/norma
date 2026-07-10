import { describe, expect, test } from "bun:test";
import { CODEX_MODELS, REASONING_EFFORTS } from "@norma/core";
import { parseModelArgs, validateEffort, validateModelSlug } from "../src/model-cli";

describe("parseModelArgs", () => {
  test("no args -> show", () => {
    expect(parseModelArgs([])).toEqual({ kind: "show" });
  });

  test("a bare slug -> setModel", () => {
    expect(parseModelArgs(["gpt-5.6-sol"])).toEqual({ kind: "setModel", slug: "gpt-5.6-sol" });
  });

  test("--effort <level> alone -> setEffort (effort-only change)", () => {
    expect(parseModelArgs(["--effort", "high"])).toEqual({ kind: "setEffort", effort: "high" });
  });

  test("<slug> --effort <level> -> setModelAndEffort", () => {
    expect(parseModelArgs(["gpt-5.6-luna", "--effort", "xhigh"])).toEqual({ kind: "setModelAndEffort", slug: "gpt-5.6-luna", effort: "xhigh" });
  });

  test("--effort with no value -> usageError", () => {
    expect(parseModelArgs(["--effort"])).toMatchObject({ kind: "usageError" });
  });

  test("--effort with trailing garbage -> usageError", () => {
    expect(parseModelArgs(["--effort", "high", "extra"])).toMatchObject({ kind: "usageError" });
  });

  test("slug --effort with no value -> usageError", () => {
    expect(parseModelArgs(["gpt-5.6-sol", "--effort"])).toMatchObject({ kind: "usageError" });
  });

  test("slug --effort with trailing garbage -> usageError", () => {
    expect(parseModelArgs(["gpt-5.6-sol", "--effort", "high", "extra"])).toMatchObject({ kind: "usageError" });
  });

  test("a slug-position flag (looks like an unknown option) -> usageError", () => {
    expect(parseModelArgs(["--bogus"])).toMatchObject({ kind: "usageError" });
  });

  test("slug followed by an unrecognized second token -> usageError", () => {
    expect(parseModelArgs(["gpt-5.6-sol", "bogus"])).toMatchObject({ kind: "usageError" });
  });
});

describe("validateModelSlug", () => {
  test("codex-oauth: every CODEX_MODELS entry is valid", () => {
    for (const m of CODEX_MODELS) {
      expect(validateModelSlug("codex-oauth", m.id)).toBeNull();
    }
  });

  test("codex-oauth: a deprecated slug is rejected with a clear message listing valid slugs", () => {
    const err = validateModelSlug("codex-oauth", "gpt-5.4");
    expect(err).not.toBeNull();
    expect(err).toContain("gpt-5.4");
    for (const m of CODEX_MODELS) expect(err).toContain(m.id);
  });

  test("codex-oauth: an unknown slug is rejected", () => {
    expect(validateModelSlug("codex-oauth", "totally-made-up")).not.toBeNull();
  });

  test("openai-compatible: any non-empty slug is accepted (no allowlist)", () => {
    expect(validateModelSlug("openai-compatible", "whatever-arbitrary-model")).toBeNull();
    expect(validateModelSlug("openai-compatible", "gpt-5.4")).toBeNull(); // even a codex-deprecated slug — no cross-provider allowlist
  });

  test("openai-compatible: an empty slug is rejected", () => {
    expect(validateModelSlug("openai-compatible", "")).not.toBeNull();
    expect(validateModelSlug("openai-compatible", "   ")).not.toBeNull();
  });
});

describe("validateEffort", () => {
  test("every documented effort slug is valid", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(validateEffort(effort)).toBeNull();
    }
  });

  test("an unknown effort slug is rejected with a clear message listing valid slugs", () => {
    const err = validateEffort("bogus");
    expect(err).not.toBeNull();
    for (const effort of REASONING_EFFORTS) expect(err).toContain(effort);
  });
});
