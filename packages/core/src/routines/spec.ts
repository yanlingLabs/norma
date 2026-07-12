// Pure spec parser + next-run-time math for scheduled routines (Phase 5). No I/O, no
// randomness, no ambient wall-clock reads inside these functions — every "now" is the
// caller-supplied `fromMs`, so callers (store, scheduler, tests) fully control time.
//
// Two spec grammars:
//   - Interval:  "every <N><s|m|h|d>"           (N a positive integer)
//   - Cron:      5 whitespace-separated fields  "m h dom mon dow"
//
// Cron field grammar (each of the 5 fields is a comma-separated list of parts):
//   part := N | ('*' | A-B) ['/' step]
// A step is only meaningful over a span, so it requires a '*' or range base — a bare-value
// step like "5/15" is rejected (Vixie cron would silently treat it as just "5"; failing loud
// beats silently diverging from whatever the user meant).
// Standard ranges: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12,
// day-of-week 0-6 (0 = Sunday; 7 is also accepted and normalized to 0, per common cron usage).
//
// nextRunAt() deliberately operates in LOCAL time, not UTC: routines are user-facing
// wall-clock schedules ("9am every day" means 9am where the user is), so all field reads
// (getMinutes/getHours/getDate/getMonth/getDay) are local-time accessors. This means a
// spec's meaning shifts with the host machine's timezone/DST — that's the intended
// behavior for a personal-assistant scheduler, not a bug.

export type CronField = { any: true } | { any: false; values: Set<number> };

export type RoutineSpec =
  | { kind: "interval"; ms: number }
  | { kind: "cron"; m: CronField; h: CronField; dom: CronField; mon: CronField; dow: CronField };

// A literal object (not Record<string, number>) so indexing by its own keyof stays a plain
// `number` under noUncheckedIndexedAccess instead of widening to `number | undefined`.
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

type FieldKey = "m" | "h" | "dom" | "mon" | "dow";

const FIELD_RANGES: Record<FieldKey, { min: number; max: number; label: string }> = {
  m: { min: 0, max: 59, label: "minute" },
  h: { min: 0, max: 23, label: "hour" },
  dom: { min: 1, max: 31, label: "day-of-month" },
  mon: { min: 1, max: 12, label: "month" },
  dow: { min: 0, max: 7, label: "day-of-week" },
};

function parseCronField(raw: string, key: FieldKey): CronField {
  const { min, max, label } = FIELD_RANGES[key];
  if (raw.length === 0) {
    throw new TypeError(`invalid cron field "" (${label}): field is empty`);
  }
  const parts = raw.split(",");
  if (parts.some((p) => p.length === 0)) {
    throw new TypeError(`invalid cron field "${raw}" (${label}): empty item in comma-separated list`);
  }

  // Only a bare "*" (no list, no step) counts as "unrestricted" — this matters for the
  // POSIX dom/dow OR-semantics in cronMatches, which keys off this exact distinction
  // (e.g. "*/15" is a restricted field even though it covers the whole range with a step).
  const any = raw === "*";
  const values = new Set<number>();

  for (const part of parts) {
    const slashIdx = part.indexOf("/");
    const basePart = slashIdx === -1 ? part : part.slice(0, slashIdx);
    const stepPart = slashIdx === -1 ? undefined : part.slice(slashIdx + 1);
    if (basePart.length === 0) {
      throw new TypeError(`invalid cron field "${raw}" (${label}): malformed item "${part}"`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new TypeError(`invalid cron field "${raw}" (${label}): step "${stepPart}" must be a positive integer`);
      }
      step = Number(stepPart);
    }

    let lo: number;
    let hi: number;
    if (basePart === "*") {
      lo = min;
      hi = max;
    } else if (stepPart !== undefined && !basePart.includes("-")) {
      // "5/15" — a step over a single value is a silent no-op in Vixie cron (== "5");
      // reject it loudly instead of quietly meaning something else.
      throw new TypeError(
        `invalid cron field "${raw}" (${label}): step requires a range or * base (e.g. "*/15" or "2-10/2"), got "${part}"`,
      );
    } else if (basePart.includes("-")) {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(basePart);
      if (!rangeMatch) {
        throw new TypeError(`invalid cron field "${raw}" (${label}): malformed range "${basePart}"`);
      }
      lo = Number(rangeMatch[1]);
      hi = Number(rangeMatch[2]);
      if (lo > hi) {
        throw new TypeError(`invalid cron field "${raw}" (${label}): range "${basePart}" has start > end`);
      }
    } else {
      if (!/^\d+$/.test(basePart)) {
        throw new TypeError(`invalid cron field "${raw}" (${label}): "${basePart}" is not a number`);
      }
      lo = hi = Number(basePart);
    }

    if (lo < min || hi > max) {
      throw new TypeError(`invalid cron field "${raw}" (${label}): value out of range ${min}-${max}`);
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(key === "dow" && v === 7 ? 0 : v); // 7 == Sunday alias, normalize to 0
    }
  }

  return any ? { any: true } : { any: false, values };
}

export function parseSpec(raw: string): RoutineSpec {
  const trimmed = raw.trim();

  const intervalMatch = /^every\s+(\d+)([smhd])$/.exec(trimmed);
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2] as "s" | "m" | "h" | "d";
    if (n <= 0) {
      throw new TypeError(`invalid interval spec "${raw}": N must be a positive integer, got ${n}`);
    }
    return { kind: "interval", ms: n * UNIT_MS[unit] };
  }
  if (/^every\b/.test(trimmed)) {
    throw new TypeError(`invalid interval spec "${raw}": expected "every <N><s|m|h|d>" (e.g. "every 30m")`);
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(
      `invalid cron spec "${raw}": expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [mRaw, hRaw, domRaw, monRaw, dowRaw] = fields as [string, string, string, string, string];
  const m = parseCronField(mRaw, "m");
  const h = parseCronField(hRaw, "h");
  const dom = parseCronField(domRaw, "dom");
  const mon = parseCronField(monRaw, "mon");
  const dow = parseCronField(dowRaw, "dow");
  return { kind: "cron", m, h, dom, mon, dow };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/** Date-level (mon + dom/dow) match for a calendar day, with POSIX dom/dow OR-semantics:
 *  if BOTH dom and dow are restricted (not bare "*"), the day matches when EITHER matches;
 *  if only one is restricted, that one alone decides; if neither, every day matches. */
function dayMatches(spec: Extract<RoutineSpec, { kind: "cron" }>, date: Date): boolean {
  if (!fieldMatches(spec.mon, date.getMonth() + 1)) return false;
  if (spec.dom.any && spec.dow.any) return true;
  if (spec.dom.any) return fieldMatches(spec.dow, date.getDay());
  if (spec.dow.any) return fieldMatches(spec.dom, date.getDate());
  return fieldMatches(spec.dom, date.getDate()) || fieldMatches(spec.dow, date.getDay());
}

const MINUTE_MS = 60_000;
// 8 years: covers the longest possible gap between Feb 29 occurrences (e.g. 1896 → 1904
// across a non-leap century year), so "0 0 29 2 *" always resolves instead of falsely
// throwing. Genuinely impossible dates (Feb 30) still exhaust the scan and throw.
const MAX_SCAN_MS = 2922 * 24 * 60 * 60 * 1000;

/** Strictly greater than fromMs. Interval specs: fromMs + ms. Cron specs: finds the next
 *  matching minute boundary (local time, zero seconds), scanning up to ~8 years before
 *  declaring the spec unsatisfiable (e.g. "0 0 30 2 *" — Feb 30 never exists).
 *
 *  The scan steps at DAY granularity while the calendar date doesn't match (and HOUR
 *  granularity while the hour doesn't), so the widened 8-year bound stays cheap — worst
 *  case is ~2,922 day-checks plus the minutes of the matching days, not 4M+ minute-checks.
 *  Jumps are computed via the local-time Date constructor (never raw ms arithmetic) so
 *  DST transitions can't skip over or double-count a wall-clock hour. */
export function nextRunAt(spec: RoutineSpec, fromMs: number): number {
  if (spec.kind === "interval") return fromMs + spec.ms;

  const from = new Date(fromMs);
  let candidate = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    from.getHours(),
    from.getMinutes(),
    0,
    0,
  ).getTime();
  if (candidate <= fromMs) candidate += MINUTE_MS;

  const deadline = fromMs + MAX_SCAN_MS;
  while (candidate <= deadline) {
    const d = new Date(candidate);
    if (!dayMatches(spec, d)) {
      // Skip to the next local midnight (guard: never move backwards/stall on odd tz rules).
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      candidate = next > candidate ? next : candidate + MINUTE_MS;
      continue;
    }
    if (!fieldMatches(spec.h, d.getHours())) {
      // Skip to the top of the next local hour.
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
      candidate = next > candidate ? next : candidate + MINUTE_MS;
      continue;
    }
    if (fieldMatches(spec.m, d.getMinutes())) return candidate;
    candidate += MINUTE_MS;
  }
  throw new TypeError(
    `cron spec is unsatisfiable: no matching time found within 8 years of ${new Date(fromMs).toISOString()}`,
  );
}
