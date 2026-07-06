import XCTest
@testable import Norma

final class ActivityRowTests: XCTestCase {
    func testGlyphMapping() {
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .tool(name: "bash"))).glyph, "⚙")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .tool(name: "bash"))).label, "bash")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "pending"))).glyph, "☐")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "in_progress"))).glyph, "◐")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "completed"))).glyph, "☑")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .subagent(agentType: "general"))).glyph, "⌥")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .subagentDone)).glyph, "✓")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .worktree(entered: true, detail: "wt-1"))).glyph, "⛿")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .worktree(entered: false, detail: "wt-1"))).glyph, "⟲")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .interaction("needs approval"))).glyph, "⚠")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "weird"))).glyph, "☐", "unknown status falls back to pending glyph")
    }
}
