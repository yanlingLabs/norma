import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../providers/types";

/** Scripted provider for engine tests: each call to streamTurn plays the next script entry. */
const DEFAULT_MODELS: ModelInfo[] = [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }];

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly requests: TurnRequest[] = [];
  private call = 0;

  constructor(
    private readonly script: ProviderEvent[][],
    private readonly modelInfos: ModelInfo[] = DEFAULT_MODELS,
  ) {}

  models(): ModelInfo[] { return this.modelInfos; }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    // AbortSignal is not structured-cloneable — snapshot everything else, keep the signal by reference
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    const events = this.script[Math.min(this.call++, this.script.length - 1)] ?? [];
    for (const e of events) yield e;
  }
}
