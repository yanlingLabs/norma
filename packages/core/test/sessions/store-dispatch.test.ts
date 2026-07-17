import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";

function freshStore() { return new SessionStore(mkdtempSync(join(tmpdir(), "norma-test-"))); }

describe("dispatch session store", () => {
  test("createSession persists mode and parentSessionId; list and meta carry them", () => {
    const store = freshStore();
    const d = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto", origin: "dispatch", mode: "dispatch" });
    const c = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto", origin: "dispatch-child", mode: "code", parentSessionId: d });
    const rows = store.list();
    expect(rows.find((r) => r.sessionId === d)?.mode).toBe("dispatch");
    expect(rows.find((r) => r.sessionId === c)?.parentSessionId).toBe(d);
    expect(store.meta(d).mode).toBe("dispatch");
    expect(store.meta(c).origin).toBe("dispatch-child");
    expect(store.meta(c).parentSessionId).toBe(d);
  });
  test("dispatchSessionId finds the singleton; childrenOf lists children", () => {
    const store = freshStore();
    expect(store.dispatchSessionId()).toBeUndefined();
    const d = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const c1 = store.createSession("global", { parentSessionId: d, origin: "dispatch-child" });
    store.createSession("global", {}); // unrelated
    expect(store.dispatchSessionId()).toBe(d);
    expect(store.childrenOf(d).map((r) => r.sessionId)).toEqual([c1]);
  });
});
