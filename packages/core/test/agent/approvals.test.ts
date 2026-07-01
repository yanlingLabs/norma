import { describe, expect, test } from "bun:test";
import { ApprovalBroker } from "../../src/agent/approvals";

describe("ApprovalBroker", () => {
  test("resolve settles the waiting promise, first-wins", async () => {
    const b = new ApprovalBroker();
    const pending = b.wait("s1", "c1", 5000);
    expect(b.resolve("s1", "c1", true, "orb")).toEqual({ ok: true, alreadyResolved: false });
    expect(b.resolve("s1", "c1", false, "cli")).toEqual({ ok: true, alreadyResolved: true }); // late answer acknowledged
    await expect(pending).resolves.toEqual({ approved: true, by: "orb" });
  });

  test("timeout auto-denies", async () => {
    const b = new ApprovalBroker();
    await expect(b.wait("s1", "c2", 20)).resolves.toEqual({ approved: false, by: "timeout" });
  });

  test("resolving an unknown approval reports alreadyResolved", () => {
    const b = new ApprovalBroker();
    expect(b.resolve("s1", "nope", true, "x")).toEqual({ ok: true, alreadyResolved: true });
  });
});
