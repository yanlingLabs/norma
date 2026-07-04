import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// `runThread` itself is private and its child-thread paths (excludeTools/allowTools/depth) are
// exercised by the later sub-agent work (T5). Here we cover `buildInstructionsFull`, the other
// new private helper extracted alongside it — it's the exact L233-251 logic `turn()` used to
// inline, now shared so a future child thread can build its own instructions the same way.
describe("engine: buildInstructionsFull (helper backing turn()/runThread)", () => {
  test("plan policy appends the '# Plan mode' reminder", () => {
    const provider = new FakeProvider([]);
    const { engine, cwd } = setupEngine(provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (engine as any).buildInstructionsFull("base instructions", cwd, new Set<string>(), "plan");
    expect(result).toContain("# Plan mode");
  });

  test("non-plan policy with no deferred tools (registry unset → toolSearch disabled) returns the base string unchanged", () => {
    const provider = new FakeProvider([]);
    const { engine, cwd } = setupEngine(provider); // toolSearch left undefined → deferredIndex never consulted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (engine as any).buildInstructionsFull("base instructions", cwd, new Set<string>(), "auto");
    expect(result).toBe("base instructions");
  });
});
