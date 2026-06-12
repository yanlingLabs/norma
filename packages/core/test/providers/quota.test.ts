import { describe, expect, test } from "bun:test";
import { QuotaManager, withQuota } from "../../src/providers/quota";
import type { Provider, ProviderEvent } from "../../src/providers/types";

function fakeProvider(script: ProviderEvent[][]): Provider & { active: () => number } {
  let calls = 0, active = 0, maxActive = 0;
  return {
    id: "fake", models: () => [],
    active: () => maxActive,
    async *streamTurn() {
      const events = script[Math.min(calls, script.length - 1)]!;
      calls++;
      active++; maxActive = Math.max(maxActive, active);
      try {
        for (const e of events) { await new Promise((r) => setTimeout(r, 5)); yield e; }
      } finally { active--; }
    },
  };
}

const ok: ProviderEvent[] = [{ type: "text_delta", delta: "x" }, { type: "usage", inputTokens: 2, outputTokens: 1 }, { type: "done", stopReason: "end_turn" }];
const limited: ProviderEvent[] = [{ type: "error", code: "rate_limit", message: "429", retryAfterMs: 30 }];

async function drain(iter: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = []; for await (const e of iter) out.push(e); return out;
}

describe("QuotaManager", () => {
  test("caps concurrent model calls", async () => {
    const fake = fakeProvider([ok]);
    const q = new QuotaManager({ maxConcurrent: 2 });
    const wrapped = withQuota(fake, q);
    await Promise.all(Array.from({ length: 6 }, () => drain(wrapped.streamTurn({ model: "m", input: [] }))));
    expect(fake.active()).toBeLessThanOrEqual(2);
  });

  test("rate_limit is retried with backoff and succeeds", async () => {
    const fake = fakeProvider([limited, ok]);
    const q = new QuotaManager({ maxConcurrent: 1 });
    const states: string[] = [];
    q.onStateChange((s) => states.push(s.kind));
    const events = await drain(withQuota(fake, q).streamTurn({ model: "m", input: [] }));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(states).toContain("limited");
    expect(states.at(-1)).toBe("ok");
  });

  test("gives up after maxRetries and surfaces the error", async () => {
    const fake = fakeProvider([limited, limited, limited, limited]);
    const q = new QuotaManager({ maxConcurrent: 1, maxRetries: 2 });
    const events = await drain(withQuota(fake, q).streamTurn({ model: "m", input: [] }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "rate_limit" });
  });

  test("accumulates usage across turns", async () => {
    const fake = fakeProvider([ok]);
    const q = new QuotaManager({ maxConcurrent: 1 });
    const w = withQuota(fake, q);
    await drain(w.streamTurn({ model: "m", input: [] }));
    await drain(w.streamTurn({ model: "m", input: [] }));
    expect(q.usage()).toEqual({ inputTokens: 4, outputTokens: 2 });
  });
});
