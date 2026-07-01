import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store";
import { SessionHub, type HubClient } from "../src/sessions/hub";
import type { SessionEvent } from "@norma/protocol";

function fakeClient(name: string): HubClient & { received: SessionEvent[] } {
  const received: SessionEvent[] = [];
  return { clientName: name, received, deliver(e: SessionEvent) { received.push(e); return true; } };
}

function setup() {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-hub-")));
  return { store, hub: new SessionHub(store) };
}

describe("SessionHub", () => {
  test("attach replays history from fromSeq and broadcasts harness_attached", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");

    hub.attach(a, id, 0);
    // a got the replayed session_created (seq 1) and its own harness_attached (seq 2)
    expect(a.received.map((e) => e.type)).toEqual(["session_created", "harness_attached"]);

    hub.attach(b, id, 0);
    // b replays seqs 1-2 then gets its own attached event; a sees b's attach live
    expect(b.received.map((e) => e.type)).toEqual(["session_created", "harness_attached", "harness_attached"]);
    expect(a.received).toHaveLength(3);
  });

  test("send appends user_message and delivers to ALL attached clients", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");
    hub.attach(a, id, 0);
    hub.attach(b, id, 0);

    const seq = hub.send(a, id, "hello from a");
    const lastA = a.received[a.received.length - 1]!;
    const lastB = b.received[b.received.length - 1]!;
    expect(lastA).toMatchObject({ type: "user_message", text: "hello from a", clientName: "a", seq });
    expect(lastB).toEqual(lastA);
  });

  test("detach broadcasts harness_detached to remaining clients and stops delivery", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");
    hub.attach(a, id, 0);
    hub.attach(b, id, 0);

    hub.detach(a);
    const lastB = b.received[b.received.length - 1]!;
    expect(lastB).toMatchObject({ type: "harness_detached", clientName: "a" });

    const countA = a.received.length;
    hub.send(b, id, "a should not see this");
    expect(a.received).toHaveLength(countA);
  });

  test("send to a session the client is not attached to throws", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const stranger = fakeClient("stranger");
    expect(() => hub.send(stranger, id, "hi")).toThrow(/not attached/);
  });

  test("re-attach to a second session moves the client (no ghost deliveries)", () => {
    const { store, hub } = setup();
    const s1 = store.createSession("global");
    const s2 = store.createSession("global");
    const mover = fakeClient("mover");
    const watcher = fakeClient("watcher");
    hub.attach(watcher, s1, 0);
    hub.attach(mover, s1, 0);
    hub.attach(mover, s2, 0); // move
    const before = mover.received.length;
    hub.send(watcher, s1, "only for s1");
    expect(mover.received).toHaveLength(before); // no ghost delivery from s1
    // watcher saw mover detach from s1:
    expect(watcher.received.some((e) => e.type === "harness_detached" && e.clientName === "mover")).toBe(true);
  });

  test("a client whose deliver throws is evicted; others still receive events", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    let boom = false;
    const bad: HubClient = { clientName: "bad", deliver() { if (boom) throw new Error("socket dead"); return true; } };
    hub.attach(good, id, 0);
    hub.attach(bad, id, 0);
    boom = true;
    hub.send(good, id, "first");
    // good got its own message AND bad's eviction notice:
    expect(good.received.some((e) => e.type === "user_message" && e.text === "first")).toBe(true);
    expect(good.received.some((e) => e.type === "harness_detached" && e.clientName === "bad")).toBe(true);
    // bad is gone — further sends don't throw and don't deliver to it:
    expect(() => hub.send(good, id, "second")).not.toThrow();
  });

  test("detach of a never-attached client is a no-op", () => {
    const { store, hub } = setup();
    store.createSession("global");
    expect(() => hub.detach(fakeClient("nobody"))).not.toThrow();
  });

  test("a client whose deliver returns false is evicted synchronously", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    let alive = true;
    const flaky: HubClient = { clientName: "flaky", deliver() { return alive; } };
    hub.attach(good, id, 0);
    hub.attach(flaky, id, 0);
    alive = false; // next delivery reports the client is dead
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "x", clientName: "good" });
    // good sees its own message AND flaky's synchronous eviction notice:
    expect(good.received.some((e) => e.type === "user_message" && e.text === "x")).toBe(true);
    expect(good.received.some((e) => e.type === "harness_detached" && e.clientName === "flaky")).toBe(true);
    // flaky is gone — a further append does not deliver to it and does not re-evict:
    const before = good.received.length;
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "y", clientName: "good" });
    expect(good.received.length).toBe(before + 1); // only the user_message, no second detached
  });
});
