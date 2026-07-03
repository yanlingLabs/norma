import { describe, expect, test } from "bun:test";
import { PlanBroker } from "../../src/agent/plans";

describe("PlanBroker", () => {
  test("wait/respond round-trip", async () => {
    const b = new PlanBroker();
    const p = b.wait("s", "c", 5000);
    expect(b.respond("s", "c", { approved: true, autoAccept: false }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p).toEqual({ approved: true, autoAccept: false, by: "cli" });
  });

  test("first-wins: second respond → alreadyResolved", async () => {
    const b = new PlanBroker();
    const p = b.wait("s", "c", 5000);
    expect(b.respond("s", "c", { approved: true, autoAccept: false }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(b.respond("s", "c", { approved: false, autoAccept: false }, "orb")).toEqual({ ok: true, alreadyResolved: true });
    expect(await p).toEqual({ approved: true, autoAccept: false, by: "cli" });
  });

  test("timeout → {timedOut:true}", async () => {
    const b = new PlanBroker();
    expect(await b.wait("s", "c", 10)).toEqual({ timedOut: true });
  });

  test("keyed isolation (sessions/callIds independent)", async () => {
    const b = new PlanBroker();
    const p1 = b.wait("s1", "c", 5000);
    const p2 = b.wait("s2", "c", 10);
    expect(b.respond("s1", "c", { approved: true, autoAccept: false }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p1).toEqual({ approved: true, autoAccept: false, by: "cli" });
    expect(await p2).toEqual({ timedOut: true });
  });

  test("resolving an unknown plan reports alreadyResolved", () => {
    const b = new PlanBroker();
    expect(b.respond("s", "nope", { approved: true, autoAccept: false }, "cli")).toEqual({ ok: true, alreadyResolved: true });
  });

  test("autoAccept and feedback are carried through", async () => {
    const b = new PlanBroker();
    const p = b.wait("s", "c", 5000);
    expect(b.respond("s", "c", { approved: false, feedback: "needs more detail", autoAccept: true }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p).toEqual({ approved: false, feedback: "needs more detail", autoAccept: true, by: "cli" });
  });
});
