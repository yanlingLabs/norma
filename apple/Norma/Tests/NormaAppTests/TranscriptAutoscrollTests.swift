import XCTest
@testable import Norma

final class TranscriptAutoscrollTests: XCTestCase {
    func testAutoscrollOnlyWhenNearBottomAndGrew() {
        XCTAssertTrue(shouldAutoscroll(nearBottom: true, contentGrew: true))
        XCTAssertFalse(shouldAutoscroll(nearBottom: false, contentGrew: true))
        XCTAssertFalse(shouldAutoscroll(nearBottom: true, contentGrew: false))
    }

    @MainActor
    func testAdapterTranscriptAndStreamingAccessors() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertTrue(adapter.transcript.isEmpty)
        XCTAssertNil(adapter.liveStreamingText)

        // Drive one user message + turn + delta via the session's test seam (mirrors
        // StoppedFlashTests' event-driving idiom).
        session.applyForTesting { s in
            s.turnRunning = true
            s.exchanges = [Exchange(prompt: "hi", reply: "")]
        }
        session.applyForTesting { s in
            s.streamingText = "partial…"
        }

        XCTAssertEqual(adapter.transcript.count, 1)
        XCTAssertEqual(adapter.liveStreamingText, "partial…")
    }
}
