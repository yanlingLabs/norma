import { describe, expect, test } from "bun:test";
import { OutputCoalescer } from "../../src/agent/bg-coalescer";

describe("OutputCoalescer", () => {
  test("coalesces multiple pushes into one flush", () => {
    const out: string[] = [];
    const c = new OutputCoalescer((s) => out.push(s));
    c.push("a"); c.push("b"); c.push("c");
    c.flush(); // deterministic manual flush (drain path)
    expect(out).toEqual(["abc"]);
    c.flush(); // nothing buffered → no-op
    expect(out).toEqual(["abc"]);
  });

  test("emits [output truncated] once at the persist cap, then drops", () => {
    const out: string[] = [];
    const c = new OutputCoalescer((s) => out.push(s), { persistCap: 10 });
    c.push("12345"); c.flush();
    c.push("67890X"); c.flush();   // crosses the 10-byte cap
    c.push("more"); c.flush();      // dropped
    c.push("evenmore"); c.flush();  // dropped
    expect(out[0]).toBe("12345");
    expect(out).toContain("[output truncated]");
    // exactly one truncation marker; nothing after it:
    expect(out.filter((s) => s === "[output truncated]")).toHaveLength(1);
    expect(out[out.length - 1]).toBe("[output truncated]");
  });

  test("dispose does a final flush and stops the timer", () => {
    const out: string[] = [];
    const c = new OutputCoalescer((s) => out.push(s));
    c.push("tail");
    c.dispose();
    expect(out).toEqual(["tail"]);
  });
});
