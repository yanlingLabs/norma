import { describe, expect, test } from "bun:test";
import { QuestionBroker } from "../../src/agent/questions";

describe("QuestionBroker", () => {
  test("wait/respond round-trip", async () => {
    const b = new QuestionBroker();
    const p = b.wait("s", "c", 5000);
    expect(b.respond("s", "c", { Q: "A" }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p).toEqual({ answers: { Q: "A" }, by: "cli" });
  });

  test("first-wins: second respond → alreadyResolved", async () => {
    const b = new QuestionBroker();
    const p = b.wait("s", "c", 5000);
    expect(b.respond("s", "c", { Q: "A" }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(b.respond("s", "c", { Q: "B" }, "orb")).toEqual({ ok: true, alreadyResolved: true });
    expect(await p).toEqual({ answers: { Q: "A" }, by: "cli" });
  });

  test("timeout → {timedOut:true}", async () => {
    const b = new QuestionBroker();
    expect(await b.wait("s", "c", 10)).toEqual({ timedOut: true });
  });

  test("keyed isolation (sessions/callIds independent)", async () => {
    const b = new QuestionBroker();
    const p1 = b.wait("s1", "c", 5000);
    const p2 = b.wait("s2", "c", 10);
    expect(b.respond("s1", "c", { Q: "A" }, "cli")).toEqual({ ok: true, alreadyResolved: false });
    expect(await p1).toEqual({ answers: { Q: "A" }, by: "cli" });
    expect(await p2).toEqual({ timedOut: true });
  });

  test("resolving an unknown question reports alreadyResolved", () => {
    const b = new QuestionBroker();
    expect(b.respond("s", "nope", { Q: "A" }, "cli")).toEqual({ ok: true, alreadyResolved: true });
  });
});
