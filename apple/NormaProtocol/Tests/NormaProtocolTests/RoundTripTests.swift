import XCTest
@testable import NormaProtocol

final class RoundTripTests: XCTestCase {
    func fixtureURLs() throws -> [URL] {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        XCTAssertEqual(urls.count, 24, "expected 24 fixtures — regenerate via pnpm protocol:generate")
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
}
