import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../providers/types";

/** FakeProvider variant that snapshots input per round and can gate each round on a promise. */
export class GatedProvider implements Provider {
  readonly id = "gated";
  readonly requests: Array<TurnRequest & { inputSnapshot: TurnRequest["input"] }> = [];
  private call = 0;
  constructor(private readonly script: ProviderEvent[][], private readonly gates: Array<Promise<void> | null> = []) {}
  models(): ModelInfo[] { return [{ id: "gated-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const i = this.call++;
    this.requests.push({ ...req, inputSnapshot: [...req.input] }); // snapshot input at THIS round
    const gate = this.gates[i];
    if (gate) await gate;
    for (const e of this.script[Math.min(i, this.script.length - 1)] ?? []) yield e;
  }
}

/** streamTurn blocks until the abort signal fires, then yields done(aborted). For interrupt tests. */
export class AbortAwaitProvider implements Provider {
  readonly id = "abort-await";
  readonly requests: TurnRequest[] = [];
  models(): ModelInfo[] { return [{ id: "aa-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    await new Promise<void>((resolve) => {
      if (req.signal?.aborted) return resolve();
      req.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "done", stopReason: "aborted" };
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
