import { describe, expect, test } from "bun:test";
import { RpcRequest, RpcResponse, RpcNotification, parseIncoming } from "../src/jsonrpc";

describe("jsonrpc envelopes", () => {
  test("valid request parses", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "session.create", params: { scope: "global" } };
    expect(RpcRequest.parse(msg)).toEqual(msg);
  });

  test("request without id is a notification, not a request", () => {
    const msg = { jsonrpc: "2.0", method: "event", params: {} };
    expect(() => RpcRequest.parse(msg)).toThrow();
    expect(RpcNotification.parse(msg)).toEqual(msg);
  });

  test("success and error responses parse", () => {
    expect(RpcResponse.parse({ jsonrpc: "2.0", id: 1, result: { ok: true } }).id).toBe(1);
    const err = RpcResponse.parse({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "unauthorized" } });
    expect("error" in err && err.error.code).toBe(-32001);
  });

  test("notification WITH an id is rejected (refine must see unknown keys)", () => {
    expect(() => RpcNotification.parse({ jsonrpc: "2.0", method: "m", id: 1 })).toThrow();
  });

  test("parseIncoming discriminates request vs notification vs response", () => {
    expect(parseIncoming({ jsonrpc: "2.0", id: 1, method: "m" }).kind).toBe("request");
    expect(parseIncoming({ jsonrpc: "2.0", method: "m" }).kind).toBe("notification");
    expect(parseIncoming({ jsonrpc: "2.0", id: 1, result: {} }).kind).toBe("response");
    expect(() => parseIncoming({ hello: "garbage" })).toThrow();
  });
});
