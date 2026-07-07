import XCTest
@testable import Norma

/// Task 1: the shared pure task-display module — sort/collapse/glyph/elapsed/tokens. Lockstep
/// twin of `packages/cli/test/task-display.test.ts` — SAME fixtures/expectations on both sides
/// (see `TaskDisplay.swift` and `task-display.ts`). Tasks 3 (window) and 4 (CLI) consume this;
/// nothing renders here.
final class TaskDisplayTests: XCTestCase {
    private func row(_ id: String, _ status: String) -> TaskRow {
        TaskRow(id: id, subject: id, status: status, activeForm: nil, startedTs: nil)
    }

    func testSortInProgressPendingCompletedStable() {
        let r = sortTasksForDisplay([row("a", "completed"), row("b", "pending"), row("c", "in_progress"), row("d", "pending")])
        XCTAssertEqual(r.map(\.id), ["c", "b", "d", "a"])
    }

    func testCollapseAllIncompletePlusTwoCompletedRestCounted() {
        let sorted = sortTasksForDisplay([row("p1", "pending"), row("ip", "in_progress"), row("c1", "completed"), row("c2", "completed"), row("c3", "completed")])
        let r = collapseCompleted(sorted)
        XCTAssertEqual(r.rows.map(\.id), ["ip", "p1", "c1", "c2"])
        XCTAssertEqual(r.collapsedCompletedCount, 1)
    }

    func testCollapseAtMostTwoCompletedShowsAllCountZero() {
        let r = collapseCompleted(sortTasksForDisplay([row("c1", "completed"), row("c2", "completed")]))
        XCTAssertEqual(r.collapsedCompletedCount, 0)
    }

    func testGlyphs() {
        XCTAssertEqual(taskGlyph("in_progress"), "■")
        XCTAssertEqual(taskGlyph("completed"), "✓")
        XCTAssertEqual(taskGlyph("pending"), "☐")
        XCTAssertEqual(taskGlyph("weird"), "☐")
    }

    func testFormatElapsed() {
        XCTAssertEqual(formatElapsed(14000), "14s")
        XCTAssertEqual(formatElapsed(123000), "2m 3s")
        XCTAssertEqual(formatElapsed(3840000), "1h 4m")
    }

    func testFormatTokens() {
        XCTAssertEqual(formatTokens(842), "842")
        XCTAssertEqual(formatTokens(10600), "10.6k")
        XCTAssertEqual(formatTokens(1200000), "1.2M")
    }
}
