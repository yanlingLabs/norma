import XCTest
@testable import Norma

/// Task 3: `buildTaskSection` — the pure row-building decision behind `WindowContentView`'s
/// task section (SwiftUI's `body` isn't unit-tested, so the sort/collapse/active-row logic is
/// extracted here). Composes Task 1's `sortTasksForDisplay`/`collapseCompleted` with Task 2's
/// `TaskItem.startedTs` to surface the live-elapsed anchor for the in_progress row.
final class WindowTaskSectionTests: XCTestCase {
    private func item(_ id: String, _ status: String, startedTs: Int? = nil) -> TaskItem {
        TaskItem(id: id, subject: id, status: status, activeForm: nil, startedTs: startedTs)
    }

    func testActiveRowFirstAndStartedTsSurfaced() {
        let tasks = [item("p", "pending"), item("ip", "in_progress", startedTs: 700), item("c", "completed")]
        let result = buildTaskSection(tasks)
        XCTAssertEqual(result.rows.first?.status, "in_progress")
        XCTAssertEqual(result.activeStartedTs, 700)
        XCTAssertEqual(result.collapsedCompleted, 0)
    }

    func testManyCompletedCollapse() {
        let tasks = [item("ip", "in_progress", startedTs: 100),
                     item("c1", "completed"), item("c2", "completed"), item("c3", "completed")]
        let result = buildTaskSection(tasks)
        XCTAssertEqual(result.rows.map(\.status), ["in_progress", "completed", "completed"])
        XCTAssertEqual(result.collapsedCompleted, 1)
    }

    /// Task-3 review: the D9 invariant — with NO in_progress task, `activeStartedTs` is nil, so the
    /// view's `TimelineView` elapsed tick never mounts (no idle per-second cost). The single most
    /// important behavioral guarantee of this task, now regression-pinned.
    func testNoActiveTaskYieldsNilStartedTs() {
        let result = buildTaskSection([item("p1", "pending"), item("c1", "completed")])
        XCTAssertNil(result.activeStartedTs)
    }
}
