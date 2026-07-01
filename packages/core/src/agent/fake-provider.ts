import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../providers/types";

/** Scripted provider for engine tests: each call to streamTurn plays the next script entry. */
export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly requests: TurnRequest[] = [];
  private call = 0;

  constructor(private readonly script: ProviderEvent[][]) {}

  models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(req));
    const events = this.script[Math.min(this.call++, this.script.length - 1)] ?? [];
    for (const e of events) yield e;
  }
}
