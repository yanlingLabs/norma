import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerPushNotificationTool(r);
  return r;
}

describe("push_notification tool", () => {
  test("zod bounds: empty message, message over 500 chars, title over 100 chars all rejected", async () => {
    const r = buildRegistry();
    const badArgs = [
      { message: "" },
      { message: "x".repeat(501) },
      { message: "ok", title: "y".repeat(101) },
    ];
    for (const bad of badArgs) {
      const out = await r.execute("push_notification", bad, ctx({ notify: () => {} }));
      expect(out.isError).toBe(true);
    }
  });

  test("message at exactly 500 chars and title at exactly 100 chars are accepted", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "push_notification",
      { message: "x".repeat(500), title: "y".repeat(100) },
      ctx({ notify: () => {} }),
    );
    expect(out.isError).toBe(false);
  });

  test("calls ctx.notify with the given title/message and returns the success string", async () => {
    const r = buildRegistry();
    const calls: Array<{ title: string; message: string }> = [];
    const out = await r.execute(
      "push_notification",
      { message: "the migration finished", title: "Migration" },
      ctx({ notify: (title, message) => { calls.push({ title, message }); } }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toBe("notification sent");
    expect(calls).toEqual([{ title: "Migration", message: "the migration finished" }]);
  });

  test("omitted title defaults to \"Norma\" at the tool boundary (not the schema)", async () => {
    const r = buildRegistry();
    const calls: Array<{ title: string; message: string }> = [];
    const out = await r.execute(
      "push_notification",
      { message: "no title given" },
      ctx({ notify: (title, message) => { calls.push({ title, message }); } }),
    );
    expect(out.isError).toBe(false);
    expect(calls).toEqual([{ title: "Norma", message: "no title given" }]);
  });

  test("no ctx.notify wired → honest failure text, no throw", async () => {
    const r = buildRegistry();
    const out = await r.execute("push_notification", { message: "hi" }, ctx());
    expect(out.isError).toBe(false); // not a hard tool error — same "degrade gracefully" shape as ask_user
    expect(out.output).toBe("notification not available in this session");
  });
});
