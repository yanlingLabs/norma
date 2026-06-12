import { describe, expect, test } from "bun:test";
import { LineDecoder, encodeLine } from "../src/ndjson";

describe("NDJSON framing", () => {
  test("encodeLine appends newline", () => {
    expect(new TextDecoder().decode(encodeLine({ a: 1 }))).toBe('{"a":1}\n');
  });

  test("decoder handles one message split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push(new TextEncoder().encode('{"a"'))).toEqual([]);
    expect(d.push(new TextEncoder().encode(':1}\n'))).toEqual(['{"a":1}']);
  });

  test("decoder handles multiple messages in one chunk", () => {
    const d = new LineDecoder();
    expect(d.push(new TextEncoder().encode('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("decoder handles multi-byte UTF-8 split mid-character", () => {
    const d = new LineDecoder();
    const bytes = new TextEncoder().encode('{"t":"é"}\n'); // é is 2 bytes
    const cut = 6; // splits inside the é
    const out = [...d.push(bytes.slice(0, cut)), ...d.push(bytes.slice(cut))];
    expect(out).toEqual(['{"t":"é"}']);
  });

  test("oversized line throws", () => {
    const d = new LineDecoder(64);
    expect(() => d.push(new TextEncoder().encode("x".repeat(100)))).toThrow(/line too long/);
  });
});
