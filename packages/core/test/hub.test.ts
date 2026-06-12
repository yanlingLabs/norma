import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store";
import { SessionHub, type HubClient } from "../src/sessions/hub";
import type { SessionEvent } from "@norma/protocol";

function fakeClient(name: string): HubClient & { received: SessionEvent[] } {
  const received: SessionEvent[] = [];
  return { clientName: name, received, deliver(e: SessionEvent) { received.push(e); } };
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
});
