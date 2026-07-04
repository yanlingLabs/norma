import XCTest
@testable import NormaKit

final class ProbeArgsTests: XCTestCase {
    func testAttachWithFlags() throws {
        let r = ProbeArgs.parse(["attach", "s_abc", "--from", "12", "--token", "t0", "--socket", "/tmp/x.sock"])
        guard case .success(let a) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(a.command, "attach")
        XCTAssertEqual(a.positional, ["s_abc"])
        XCTAssertEqual(a.from, 12)
        XCTAssertEqual(a.token, "t0")
        XCTAssertEqual(a.socket, "/tmp/x.sock")
    }

    func testSendJoinsRemainingWords() throws {
        guard case .success(let a) = ProbeArgs.parse(["send", "s_1", "hello", "brave", "world"]) else { return XCTFail() }
        XCTAssertEqual(a.positional, ["s_1", "hello", "brave", "world"])
    }

    func testCreateWithCwd() throws {
        guard case .success(let a) = ProbeArgs.parse(["create", "global", "--cwd", "/tmp/p"]) else { return XCTFail() }
        XCTAssertEqual(a.cwd, "/tmp/p")
    }

    func testUnknownCommandAndMissingArgsFail() {
        guard case .failure = ProbeArgs.parse(["frobnicate"]) else { return XCTFail() }
        guard case .failure = ProbeArgs.parse([]) else { return XCTFail() }
        guard case .failure = ProbeArgs.parse(["attach"]) else { return XCTFail() } // needs sessionId
        guard case .failure = ProbeArgs.parse(["attach", "s_1", "--from", "NaN"]) else { return XCTFail() }
    }
}
