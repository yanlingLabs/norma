import XCTest
@testable import NormaProtocol

final class RoundTripTests: XCTestCase {
    func fixtureURLs() throws -> [URL] {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        XCTAssertEqual(urls.count, 40, "expected 40 fixtures — regenerate via pnpm protocol:generate")
        return urls
    }

    /// Gate (c): every TS-generated fixture decodes, re-encodes, and decodes to an equal value.
    func testAllFixturesRoundTrip() throws {
        for url in try fixtureURLs() {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(SessionEvent.self, from: data)
            let reencoded = try JSONEncoder().encode(decoded)
            let redecoded = try JSONDecoder().decode(SessionEvent.self, from: reencoded)
            XCTAssertEqual(decoded, redecoded, "round-trip mismatch for \(url.lastPathComponent)")

            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertNotNil(obj?["type"] as? String, "re-encoded JSON lost the type discriminator for \(url.lastPathComponent)")
        }
    }

    func testUnknownDiscriminatorFailsLoudly() throws {
        let bad = #"{"type":"mystery","seq":1,"sessionId":"s","ts":0}"#.data(using: .utf8)!
        XCTAssertThrowsError(try JSONDecoder().decode(SessionEvent.self, from: bad))
    }

    func testThreadStartedDescriptionOptional() throws {
        let with = #"{"type":"thread_started","seq":9,"sessionId":"s","ts":5,"threadId":"th_1","parentThreadId":"main","agentType":"general-purpose","prompt":"go","description":"explore auth module"}"#
        guard case .threadStarted(let v) = try JSONDecoder().decode(SessionEvent.self, from: Data(with.utf8)) else { return XCTFail() }
        XCTAssertEqual(v.description, "explore auth module")

        let without = #"{"type":"thread_started","seq":9,"sessionId":"s","ts":5,"threadId":"th_1","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#
        guard case .threadStarted(let v2) = try JSONDecoder().decode(SessionEvent.self, from: Data(without.utf8)) else { return XCTFail() }
        XCTAssertNil(v2.description)
    }

    /// Task-graph fields (4h-ii-d, CC parity) — additive guarantee both directions: a payload
    /// WITH owner/blocks/blockedBy/metadata decodes and re-encodes losslessly (via the
    /// TS-generated `task_with_graph_fields.json` fixture, synced from packages/protocol), and
    /// the OLD-shape `task_updated.json` fixture (predates these fields) still decodes with all
    /// four nil — mirrors `testThreadStartedDescriptionOptional`'s with/without pattern above.
    func testTaskGraphFieldsOptional() throws {
        guard let withURL = Bundle.module.url(forResource: "task_with_graph_fields", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing task_with_graph_fields.json fixture")
        }
        let withData = try Data(contentsOf: withURL)
        guard case .taskUpdated(let with) = try JSONDecoder().decode(SessionEvent.self, from: withData) else { return XCTFail() }
        XCTAssertEqual(with.task.owner, "researcher")
        XCTAssertEqual(with.task.blocks, ["5", "6"])
        XCTAssertEqual(with.task.blockedBy, ["2"])
        XCTAssertEqual(with.task.metadata?["priority"], .string("high"))
        XCTAssertEqual(with.task.metadata?["sprint"], .number(12))

        let reencoded = try JSONEncoder().encode(SessionEvent.taskUpdated(with))
        guard case .taskUpdated(let redecoded) = try JSONDecoder().decode(SessionEvent.self, from: reencoded) else { return XCTFail() }
        XCTAssertEqual(with, redecoded)

        guard let withoutURL = Bundle.module.url(forResource: "task_updated", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing task_updated.json fixture")
        }
        let withoutData = try Data(contentsOf: withoutURL)
        guard case .taskUpdated(let without) = try JSONDecoder().decode(SessionEvent.self, from: withoutData) else { return XCTFail() }
        XCTAssertNil(without.task.owner)
        XCTAssertNil(without.task.blocks)
        XCTAssertNil(without.task.blockedBy)
        XCTAssertNil(without.task.metadata)
    }
}
