import { describe, expect, test } from "bun:test";
import { attachImageGuarded, base64DecodedBytes, IMAGE_MAX_BYTES } from "../../../src/agent/tools/attach-image";

describe("base64DecodedBytes (length math only — no decode)", () => {
  test("exact against a real decode for 0/1/2-padding payloads", () => {
    for (const raw of ["a", "ab", "abc", "abcd", "hello world!", ""]) {
      const b64 = Buffer.from(raw).toString("base64");
      expect(base64DecodedBytes(b64)).toBe(Buffer.from(b64, "base64").length);
    }
  });
});

describe("attachImageGuarded (parity-tail review: bridge-level image size cap)", () => {
  const smallB64 = Buffer.from("tiny image bytes").toString("base64");

  test("under the cap: attaches the data URL, returns null", () => {
    const attached: string[] = [];
    const note = attachImageGuarded({ attachImage: (u) => attached.push(u) }, { mime: "image/png", base64: smallB64 });
    expect(note).toBeNull();
    expect(attached).toEqual([`data:image/png;base64,${smallB64}`]);
  });

  test("over the cap: returns an [image omitted: ...] note, never calls attachImage", () => {
    const attached: string[] = [];
    const note = attachImageGuarded(
      { attachImage: (u) => attached.push(u) },
      { mime: "image/png", base64: "AAAAAAAAAAAAAAAA" }, // 12 decoded bytes
      { maxBytes: 10 },
    );
    expect(note).toMatch(/^\[image omitted: .* exceeds .*\]$/);
    expect(attached).toEqual([]);
  });

  test("boundary is inclusive: exactly maxBytes attaches, one byte over is refused", () => {
    const b64 = Buffer.from("abc").toString("base64"); // 3 decoded bytes, no padding
    const attached: string[] = [];
    expect(attachImageGuarded({ attachImage: (u) => attached.push(u) }, { mime: "image/png", base64: b64 }, { maxBytes: 3 })).toBeNull();
    expect(attached).toHaveLength(1);
    expect(attachImageGuarded({ attachImage: (u) => attached.push(u) }, { mime: "image/png", base64: b64 }, { maxBytes: 2 })).toContain("[image omitted:");
    expect(attached).toHaveLength(1); // nothing new attached
  });

  test("default cap is IMAGE_MAX_BYTES (20MB): a >20MB payload is refused with sizes in the note", () => {
    // 28M base64 chars decode to exactly 21MB — pure length math, the string content is never decoded.
    const overCap = "A".repeat(28 * 1024 * 1024);
    const attached: string[] = [];
    const note = attachImageGuarded({ attachImage: (u) => attached.push(u) }, { mime: "image/png", base64: overCap });
    expect(note).toBe("[image omitted: 21.0MB exceeds 20.0MB]");
    expect(attached).toEqual([]);
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024); // the shared constant read tool/notebook/MCP all enforce
  });

  test("attachImage unwired: still returns null (presence gating stays with the caller)", () => {
    expect(attachImageGuarded({}, { mime: "image/png", base64: smallB64 })).toBeNull();
  });
});
