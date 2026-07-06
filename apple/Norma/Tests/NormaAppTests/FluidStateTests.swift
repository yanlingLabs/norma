import XCTest
@testable import Norma

@MainActor
final class FluidStateTests: XCTestCase {
    func testIdleWhenNothingHappens() {
        let a = FieldStateAdapter(session: SessionModel())
        XCTAssertEqual(a.fluidState, .idle)
    }
    func testWorkingHalfFullWithoutTasks() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in s.turnRunning = true }
        XCTAssertEqual(a.fluidState, .working(level: 0.5))
    }
    func testWorkingLevelTracksTasks() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress"),
                       TaskItem(id: "3", subject: "c", status: "pending"),
                       TaskItem(id: "4", subject: "d", status: "pending")]
        }
        XCTAssertEqual(a.fluidState, .working(level: 0.25))
    }
    func testUnreadHoldsLastWorkingLevel() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        _ = a.fluidState // observe working(1.0)
        session.applyForTesting { s in s.turnRunning = false }
        a.hasUnread = true
        XCTAssertEqual(a.fluidState, .unread(level: 1.0))
    }
    func testUnreadHoldsFinalLevelEvenWithoutInterveningReads() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress")]
        }
        // NO fluidState read here — then the burst: all-complete + turn end in quick succession
        session.applyForTesting { s in
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        session.applyForTesting { s in s.turnRunning = false }
        a.hasUnread = true
        XCTAssertEqual(a.fluidState, .unread(level: 1.0))
    }
}
