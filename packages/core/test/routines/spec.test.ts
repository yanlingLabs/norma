import { describe, expect, test } from "bun:test";
import { parseSpec, nextRunAt } from "../../src/routines/spec";

/** Local-time epoch helper matching nextRunAt's local-time semantics. */
function at(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime();
}

describe("parseSpec — interval", () => {
  test("parses every <N>s/m/h/d", () => {
    expect(parseSpec("every 45s")).toEqual({ kind: "interval", ms: 45_000 });
    expect(parseSpec("every 30m")).toEqual({ kind: "interval", ms: 30 * 60_000 });
    expect(parseSpec("every 1h")).toEqual({ kind: "interval", ms: 60 * 60_000 });
    expect(parseSpec("every 2d")).toEqual({ kind: "interval", ms: 2 * 24 * 60 * 60_000 });
  });

  test("trims surrounding whitespace", () => {
    expect(parseSpec("  every 5m  ")).toEqual({ kind: "interval", ms: 5 * 60_000 });
  });

  test("rejects N=0 with a message naming the problem", () => {
    expect(() => parseSpec("every 0m")).toThrow(TypeError);
    expect(() => parseSpec("every 0m")).toThrow(/positive integer/);
  });

  test("rejects malformed 'every' specs", () => {
    expect(() => parseSpec("every m")).toThrow(TypeError);
    expect(() => parseSpec("every")).toThrow(TypeError);
    expect(() => parseSpec("every 5x")).toThrow(TypeError); // 'x' isn't a valid unit and isn't a cron field count either
  });
});

describe("parseSpec — cron: field count", () => {
  test("wrong number of fields throws naming the count", () => {
    expect(() => parseSpec("* * *")).toThrow(TypeError);
    expect(() => parseSpec("* * *")).toThrow(/5 fields/);
    expect(() => parseSpec("* * * * * *")).toThrow(/5 fields/);
  });
});

describe("parseSpec — cron: field grammar", () => {
  test("accepts *, single values, lists, ranges, and steps in every field", () => {
    expect(() => parseSpec("* * * * *")).not.toThrow();
    expect(() => parseSpec("5 10 15 6 3")).not.toThrow();
    expect(() => parseSpec("1,15,30 * * * *")).not.toThrow();
    expect(() => parseSpec("0-29 * * * *")).not.toThrow();
    expect(() => parseSpec("*/15 * * * 1-5")).not.toThrow();
    expect(() => parseSpec("2-10/2 * * * *")).not.toThrow();
  });

  test("dow accepts 7 as a Sunday alias, normalized to 0", () => {
    const spec = parseSpec("0 0 * * 7");
    if (spec.kind !== "cron") throw new Error("expected cron spec");
    expect(spec.dow.any).toBe(false);
    expect(spec.dow.any === false && [...spec.dow.values]).toEqual([0]);
  });

  test("bare '*' is the only form that counts as unrestricted (for dom/dow OR-semantics)", () => {
    const bare = parseSpec("* * * * *");
    const stepped = parseSpec("*/15 * * * *");
    if (bare.kind !== "cron" || stepped.kind !== "cron") throw new Error("expected cron");
    expect(bare.m.any).toBe(true);
    expect(stepped.m.any).toBe(false);
  });

  test("out-of-range values throw naming the offending field", () => {
    expect(() => parseSpec("60 * * * *")).toThrow(/minute/);
    expect(() => parseSpec("* 24 * * *")).toThrow(/hour/);
    expect(() => parseSpec("* * 32 * *")).toThrow(/day-of-month/);
    expect(() => parseSpec("* * 0 * *")).toThrow(/day-of-month/);
    expect(() => parseSpec("* * * 13 *")).toThrow(/month/);
    expect(() => parseSpec("* * * 0 *")).toThrow(/month/);
    expect(() => parseSpec("* * * * 8")).toThrow(/day-of-week/);
  });

  test("range with start > end throws", () => {
    expect(() => parseSpec("10-5 * * * *")).toThrow(/start > end/);
  });

  test("non-numeric field throws TypeError", () => {
    expect(() => parseSpec("abc * * * *")).toThrow(TypeError);
  });

  test("empty comma-list item throws", () => {
    expect(() => parseSpec("1,,5 * * * *")).toThrow(TypeError);
  });

  test("non-positive step throws", () => {
    expect(() => parseSpec("*/0 * * * *")).toThrow(TypeError);
  });

  test("step on a single value (5/15) is rejected — step requires a range or *", () => {
    expect(() => parseSpec("5/15 * * * *")).toThrow(TypeError);
    expect(() => parseSpec("5/15 * * * *")).toThrow(/step requires a range or \*/);
    // ...including inside a list, and in other fields
    expect(() => parseSpec("1,5/15 * * * *")).toThrow(/step requires a range or \*/);
    expect(() => parseSpec("* * * * 3/2")).toThrow(/step requires a range or \*/);
    // range and * bases with steps remain valid
    expect(() => parseSpec("2-10/2 * * * *")).not.toThrow();
    expect(() => parseSpec("*/15 * * * *")).not.toThrow();
  });
});

describe("nextRunAt — interval", () => {
  test("returns fromMs + ms, strictly greater than fromMs", () => {
    const spec = parseSpec("every 5m");
    const from = at(2026, 3, 1, 10, 0, 0);
    const result = nextRunAt(spec, from);
    expect(result).toBe(from + 5 * 60_000);
    expect(result).toBeGreaterThan(from);
  });
});

describe("nextRunAt — cron: minute-boundary edges", () => {
  test("mid-minute fromMs rounds up to the next matching minute boundary", () => {
    const spec = parseSpec("* * * * *"); // every minute
    const from = at(2026, 3, 1, 10, 30, 15); // 10:30:15 (mid-minute)
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 1, 10, 31, 0));
  });

  test("fromMs exactly on a matching minute boundary still advances (strictly greater)", () => {
    const spec = parseSpec("* * * * *");
    const from = at(2026, 3, 1, 10, 30, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 1, 10, 31, 0));
  });
});

describe("nextRunAt — cron: field matching", () => {
  test("daily at a specific time, rolling to tomorrow when already past today", () => {
    const spec = parseSpec("0 9 * * *"); // 9:00 every day
    const from = at(2026, 3, 1, 10, 0, 0); // already past 9am
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 2, 9, 0, 0));
  });

  test("month wrap: midnight on the 1st, scanning from Jan 31 23:59 lands in February", () => {
    const spec = parseSpec("0 0 1 * *");
    const from = at(2026, 1, 31, 23, 59, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 2, 1, 0, 0, 0));
  });

  test("list field: matches any listed minute", () => {
    const spec = parseSpec("1,15,30 * * * *");
    const from = at(2026, 3, 1, 10, 2, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 1, 10, 15, 0));
  });

  test("step field: every 15 minutes", () => {
    const spec = parseSpec("*/15 * * * *");
    const from = at(2026, 3, 1, 10, 16, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 1, 10, 30, 0));
  });

  test("range/step field: 2-10/2 matches 2,4,6,8,10", () => {
    const spec = parseSpec("2-10/2 * * * *");
    const from = at(2026, 3, 1, 10, 5, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 3, 1, 10, 6, 0));
  });
});

describe("nextRunAt — cron: dom/dow POSIX OR-semantics", () => {
  // Feb 2026: the 1st is a Sunday, the 2nd is a Monday.
  test("both dom and dow restricted: matches on EITHER (15th OR Monday)", () => {
    const spec = parseSpec("0 9 15 * 1");
    const from = at(2026, 2, 1, 8, 0, 0); // Sunday morning, before both candidates
    expect(nextRunAt(spec, from)).toBe(at(2026, 2, 2, 9, 0, 0)); // next Monday comes first
  });

  test("only dom restricted (dow is '*'): dow is ignored", () => {
    const spec = parseSpec("0 9 15 * *");
    const from = at(2026, 2, 1, 8, 0, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 2, 15, 9, 0, 0));
  });

  test("only dow restricted (dom is '*'): dom is ignored", () => {
    const spec = parseSpec("0 9 * * 1"); // every Monday at 9am
    const from = at(2026, 2, 1, 8, 0, 0); // Sunday
    expect(nextRunAt(spec, from)).toBe(at(2026, 2, 2, 9, 0, 0));
  });

  test("neither restricted: matches every day", () => {
    const spec = parseSpec("0 9 * * *");
    const from = at(2026, 2, 1, 8, 0, 0);
    expect(nextRunAt(spec, from)).toBe(at(2026, 2, 1, 9, 0, 0));
  });
});

describe("nextRunAt — cron: leap years", () => {
  // 2026 and 2027 are non-leap; the next Feb 29 after them is in 2028 (leap year).
  test("Feb 29 from a non-leap year resolves to the next leap year, not 'unsatisfiable'", () => {
    const spec = parseSpec("0 0 29 2 *");
    const from = at(2026, 3, 1, 0, 0, 0); // March 2026 — just missed any Feb; gap spans 2 non-leap Febs
    expect(nextRunAt(spec, from)).toBe(at(2028, 2, 29, 0, 0, 0));
  });

  test("Feb 29 chained via recordRun-style recompute: from just after a Feb 29 fire", () => {
    const spec = parseSpec("0 0 29 2 *");
    const from = at(2028, 2, 29, 0, 0, 0); // the moment a Feb 29 routine just fired
    expect(nextRunAt(spec, from)).toBe(at(2032, 2, 29, 0, 0, 0)); // ~4 years out — must not throw
  });

  test("leap-year scan completes fast (day-level stepping, not minute-by-minute over years)", () => {
    const spec = parseSpec("0 0 29 2 *");
    const start = performance.now();
    nextRunAt(spec, at(2028, 2, 29, 0, 0, 0)); // worst realistic case: ~4-year gap
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });
});

describe("nextRunAt — cron: unsatisfiable spec", () => {
  test("Feb 30th never exists — throws after the bounded scan, and fast", () => {
    const spec = parseSpec("0 0 30 2 *");
    const from = at(2026, 1, 1, 0, 0, 0);
    const start = performance.now();
    expect(() => nextRunAt(spec, from)).toThrow(TypeError);
    expect(() => nextRunAt(spec, from)).toThrow(/unsatisfiable/);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000); // full-bound scan must stay cheap (day-level stepping)
  });
});
