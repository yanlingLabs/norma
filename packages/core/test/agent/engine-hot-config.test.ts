import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, stubReviewer, bashTurn } from "./engine-reviewer.test";
import { SubagentManager } from "../../src/agent/subagents";
import { WorktreeManager } from "../../src/agent/worktree";

// Hot-settings T2: EngineConfig's in-scope fields (reviewer.{enabled,allow,classes},
// toolSearch.{enabled,deferThreshold,deferExternals}, subagentMaxDepth), SubagentManager's
// maxConcurrent, and WorktreeManager's baseRef are now GETTERS over a live holder rather than
// values captured once at construction. These tests pin the actual contract: reassigning the
// holder mid-flight (the SAME single-statement swap a later task's watcher performs on daemon.ts's
// `let settings`) changes what the NEXT read sees — with NO reconstruction of the engine/manager
// in between. Mirrors engine-live-model.test.ts's precedent for the same "no daemon restart"
// property on `provider.live`.
describe("hot-settings T2: getters read the live holder, no reconstruction", () => {
  test("engine reviewer gating reads the CURRENT settings via the reviewerClasses getter — turn N+1 sees a live edit with the SAME engine instance", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "fine" });
    // "rm -rf x" is not bashLooksSafe-obvious (same command engine-reviewer.test.ts uses to force
    // the review branch) — two turns' worth of script: each is [tool_call, done(tool_calls)],
    // [text_delta, done(end_turn)].
    const provider = new FakeProvider([...bashTurn("rm -rf x"), ...bashTurn("rm -rf x")]);
    // Reassigned WHOLE-OBJECT between turns, never mutated in place — the exact shape a settings
    // reload's atomic swap takes.
    let live: { reviewer?: { classes?: { bash?: boolean; fs?: boolean; external?: boolean } } } = {
      reviewer: { classes: { bash: true } },
    };
    const { engine, sessionId } = setupEngine(provider, {
      registry, reviewer: reviewer as any,
      reviewerClasses: () => live.reviewer?.classes,
    });

    await engine.runTurn(sessionId);
    // bash class enabled -> "rm -rf x" is reviewed (safe verdict) -> executes
    expect(reviewer.seen.length).toBe(1);
    expect(calls.length).toBe(1);

    live = { reviewer: { classes: { bash: false } } }; // simulates a settings.json edit landing between turns

    await engine.runTurn(sessionId);
    // bash class now disabled -> short-circuits BEFORE reviewAndDispatch (no new reviewer.review()
    // call) -> still executes directly. The SAME engine instance saw the change with no rebuild.
    expect(reviewer.seen.length).toBe(1);
    expect(calls.length).toBe(2);
  });

  // hot-settings T2 review: reviewer.enabled must be hot in BOTH directions. The GAP this pins:
  // daemon.ts now ALWAYS constructs the BashReviewer (never leaves it undefined at a disabled
  // boot), so an OFF→ON flip works — the reviewer object is present the whole time, and the
  // `reviewerEnabled` getter is the sole gate on whether review actually runs.
  test("reviewer PRESENT but reviewerEnabled:()=>false → NO review (bash runs unreviewed under auto); flip live to true → review NOW runs, SAME engine, no reconstruction", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "fine" });
    const provider = new FakeProvider([...bashTurn("rm -rf x"), ...bashTurn("rm -rf x")]);
    // Reviewer stays PRESENT across both turns (mirrors daemon.ts always constructing it); only
    // the enabled flag flips, via a whole-object swap of the live holder.
    let live: { reviewer?: { enabled?: boolean } } = { reviewer: { enabled: false } };
    const { engine, sessionId } = setupEngine(provider, {
      registry, reviewer: reviewer as any,
      reviewerEnabled: () => live.reviewer?.enabled,
    });

    await engine.runTurn(sessionId);
    // enabled:false -> the reviewer-gate branch is skipped even though `cfg.reviewer` is present ->
    // bash falls straight to executeCall, unreviewed.
    expect(reviewer.seen.length).toBe(0);
    expect(calls.length).toBe(1); // ran unreviewed

    live = { reviewer: { enabled: true } }; // false→true edit landing between turns — the GAP's key case

    await engine.runTurn(sessionId);
    // enabled now true + reviewer still present -> review RUNS this turn. Proves off→on is hot with
    // the reviewer always constructed; no engine reconstruction happened between the two turns.
    expect(reviewer.seen.length).toBe(1);
    expect(calls.length).toBe(2);
  });

  test("SubagentManager.maxConcurrent getter reflects a live change", () => {
    let live: any = { subagents: { maxConcurrent: 2 } };
    const m = new SubagentManager({ maxConcurrent: () => live.subagents?.maxConcurrent });
    expect(m.currentMaxConcurrent()).toBe(2);
    live = { subagents: { maxConcurrent: 5 } };
    expect(m.currentMaxConcurrent()).toBe(5);
  });

  test("WorktreeManager.baseRef getter reflects a live change", () => {
    let live: any = { worktree: { baseRef: "head" } };
    const m = new WorktreeManager({ baseRef: () => live.worktree?.baseRef });
    expect(m.currentBaseRef()).toBe("head");
    live = { worktree: { baseRef: "fresh" } };
    expect(m.currentBaseRef()).toBe("fresh");
  });
});
