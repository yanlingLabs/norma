import XCTest
@testable import NormaProtocol

final class RoundTripTests: XCTestCase {
    func fixtureURLs() throws -> [URL] {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        XCTAssertEqual(urls.count, 34, "expected 34 fixtures — regenerate via pnpm protocol:generate")
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
}
