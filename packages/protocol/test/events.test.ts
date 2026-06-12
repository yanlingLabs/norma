import { describe, expect, test } from "bun:test";
import { SessionEvent } from "../src/events";
import { HelloParams, HelloResult, PROTOCOL_VERSION } from "../src/methods";

describe("SessionEvent discriminated union", () => {
  const base = { seq: 1, sessionId: "s_abc", ts: 1781270000000 };

  test("user_message round-trips", () => {
    const e = { ...base, type: "user_message", threadId: "main", text: "hi", source: "cli-1" } as const;
    expect(SessionEvent.parse(e)).toEqual(e);
  });

  test("each variant parses and narrows on type", () => {
    const events = [
      { ...base, type: "session_created", scope: "global" },
      { ...base, type: "harness_attached", clientName: "orb" },
      { ...base, type: "harness_detached", clientName: "orb" },
      { ...base, type: "user_message", threadId: "main", text: "x", source: "a" },
    ] as const;
    for (const e of events) {
      const parsed = SessionEvent.parse(e);
      expect(parsed.type).toBe(e.type);
    }
  });

  test("unknown type rejected; missing discriminator rejected", () => {
    expect(() => SessionEvent.parse({ ...base, type: "nope" })).toThrow();
    expect(() => SessionEvent.parse(base)).toThrow();
  });

  test("negative seq rejected", () => {
    expect(() => SessionEvent.parse({ ...base, seq: -1, type: "session_created", scope: "g" })).toThrow();
  });
});

describe("hello method schemas", () => {
  test("valid hello", () => {
    const p = { protocolVersion: PROTOCOL_VERSION, role: "harness", token: "t", clientName: "test" } as const;
    expect(HelloParams.parse(p).role).toBe("harness");
    expect(HelloResult.parse({ ok: true, serverVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION }).ok).toBe(true);
  });

  test("unknown role rejected", () => {
    expect(() => HelloParams.parse({ protocolVersion: 0, role: "root", token: "t", clientName: "x" })).toThrow();
  });
});
