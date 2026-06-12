import { describe, expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store";

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "norma-store-"));
  return { store: new SessionStore(dir), dir };
}

describe("SessionStore", () => {
  test("createSession returns id, appends session_created with seq 1", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    expect(id).toMatch(/^s_[a-z0-9]+$/);
    const events = store.read(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session_created", seq: 1, sessionId: id, scope: "global" });
  });

  test("append assigns monotonic seq and stamps ts", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const e2 = store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    const e3 = store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "b", clientName: "t" });
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(e2.ts).toBeGreaterThan(0);
  });

  test("read(fromSeq) returns only later events", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "b", clientName: "t" });
    const tail = store.read(id, 2);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(3);
  });

  test("list reflects scope and lastSeq", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: id, scope: "global", lastSeq: 2 });
  });

  test("invalid scope rejected (path-safety)", () => {
    const { store } = makeStore();
    expect(() => store.createSession("../evil")).toThrow();
    expect(() => store.createSession("UPPER")).toThrow();
  });

  test("recovery: truncated tail line is discarded, store stays writable, index rebuilt", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "ok", clientName: "t" });
    store.close();
    // Simulate a crash mid-write:
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    appendFileSync(logPath, '{"type":"user_message","seq":3,"sessio'); // no newline, truncated
    const reopened = new SessionStore(dir);
    const events = reopened.read(id);
    expect(events).toHaveLength(2); // truncated line gone
    const e = reopened.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "after", clientName: "t" });
    expect(e.seq).toBe(3); // seq continues from last GOOD event
    expect(readFileSync(logPath, "utf8").endsWith("\n")).toBe(true);
  });
});
