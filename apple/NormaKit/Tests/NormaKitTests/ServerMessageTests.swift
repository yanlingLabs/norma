import XCTest
import NormaProtocol
@testable import NormaKit

final class ServerMessageTests: XCTestCase {
    func testResponseWithResult() throws {
        let m = parseServerLine(#"{"jsonrpc":"2.0","id":3,"result":{"ok":true,"lastSeq":42}}"#)
        guard case .response(let id, .success(let v)) = m else { return XCTFail("\(m)") }
        XCTAssertEqual(id, 3)
        XCTAssertEqual(v["ok"]?.boolValue, true)
        XCTAssertEqual(v["lastSeq"]?.intValue, 42)
    }

    func testResponseWithError() throws {
        let m = parseServerLine(#"{"jsonrpc":"2.0","id":9,"error":{"code":-32001,"message":"invalid token for role"}}"#)
        guard case .response(let id, .failure(let e)) = m else { return XCTFail("\(m)") }
        XCTAssertEqual(id, 9)
        XCTAssertEqual(e, RpcError(code: -32001, message: "invalid token for role"))
    }

    func testEventNotificationDecodesSessionEvent() throws {
        let line = #"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_delta","seq":7,"sessionId":"s_1","ts":1,"threadId":"main","delta":"tok"}}"#
        guard case .event(.assistantDelta(let d)) = parseServerLine(line) else { return XCTFail() }
        XCTAssertEqual(d.delta, "tok")
        XCTAssertEqual(d.threadId, "main")
    }

    func testUnknownEventTypeWrapsRawInsteadOfCrashing() throws {
        let line = #"{"jsonrpc":"2.0","method":"event","params":{"type":"mystery_v99","seq":1,"sessionId":"s","ts":0}}"#
        guard case .unknownEvent(let raw) = parseServerLine(line) else { return XCTFail() }
        XCTAssertTrue(raw.contains("mystery_v99"))
    }

    func testGarbageLineIsUnrecognized() throws {
        guard case .unrecognized = parseServerLine("not json at all") else { return XCTFail() }
        guard case .unrecognized = parseServerLine(#"{"jsonrpc":"2.0"}"#) else { return XCTFail() }
    }

    func testJSONValueRoundTrip() throws {
        let v = JSONValue.object(["a": .array([.number(1), .string("x"), .bool(false), .null])])
        let data = try JSONEncoder().encode(v)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), v)
    }
}
