import XCTest
@testable import Norma

/// LIVE-GATE G3: pure grouping/label logic for the transcript's grouped tool lines. Drives
/// `groupActivity`/`toolGroupLabel` directly (no view involved) — mirrors `ActivityRowTests`'
/// convention of testing the pure mapper, not the SwiftUI body.
final class ActivityGroupingTests: XCTestCase {
    private func tool(_ name: String, _ detail: String? = nil) -> ActivityItem {
        ActivityItem(kind: .tool(name: name, detail: detail))
    }

    // MARK: groupActivity

    func testConsecutiveSameNameToolsMergeIntoOneGroup() {
        let items = [tool("bash", "ls"), tool("bash", "pwd"), tool("bash", nil)]
        XCTAssertEqual(groupActivity(items), [
            .tools(name: "bash", count: 3, details: ["ls", "pwd"]),
        ])
    }

    func testDifferentToolNamesFormSeparateGroups() {
        let items = [tool("bash", "ls"), tool("read", "/tmp/x")]
        XCTAssertEqual(groupActivity(items), [
            .tools(name: "bash", count: 1, details: ["ls"]),
            .tools(name: "read", count: 1, details: ["/tmp/x"]),
        ])
    }

    func testNonToolItemBreaksARunEvenIfToolsResumeAfter() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .interaction("needs approval")),
            tool("bash", "pwd"),
        ]
        XCTAssertEqual(groupActivity(items), [
            .tools(name: "bash", count: 1, details: ["ls"]),
            .single(ActivityItem(kind: .interaction("needs approval"))),
            .tools(name: "bash", count: 1, details: ["pwd"]),
        ])
    }

    func testTaskItemsAreSkippedEntirely() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            tool("bash", "pwd"),
        ]
        // The task item vanishes from grouping — AND, since it's skipped rather than treated as a
        // run-breaker, the two bash calls on either side of it still merge into one group.
        XCTAssertEqual(groupActivity(items), [
            .tools(name: "bash", count: 2, details: ["ls", "pwd"]),
        ])
    }

    func testOtherKindsPassThroughAsSingle() {
        let items: [ActivityItem] = [
            ActivityItem(kind: .subagent(agentType: "general")),
            ActivityItem(kind: .subagentDone),
            ActivityItem(kind: .worktree(entered: true, detail: "fix-x")),
        ]
        XCTAssertEqual(groupActivity(items), items.map { .single($0) })
    }

    func testDetailsCollectOnlyNonNilInOrder() {
        let items = [tool("read", nil), tool("read", "/a"), tool("read", nil), tool("read", "/b")]
        XCTAssertEqual(groupActivity(items), [
            .tools(name: "read", count: 4, details: ["/a", "/b"]),
        ])
    }

    func testEmptyInputYieldsEmptyOutput() {
        XCTAssertEqual(groupActivity([]), [])
    }

    // MARK: toolGroupLabel

    func testToolGroupLabelSingularPlural() {
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 1), "Ran a shell command")
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 3), "Ran 3 shell commands")
        XCTAssertEqual(toolGroupLabel(name: "task_create", count: 1), "Created a task")
        XCTAssertEqual(toolGroupLabel(name: "task_create", count: 4), "Created 4 tasks")
        XCTAssertEqual(toolGroupLabel(name: "task_update", count: 1), "Updated a task")
        XCTAssertEqual(toolGroupLabel(name: "task_update", count: 2), "Updated 2 tasks")
        XCTAssertEqual(toolGroupLabel(name: "task_list", count: 1), "Checked tasks")
        XCTAssertEqual(toolGroupLabel(name: "task_list", count: 5), "Checked tasks")
        XCTAssertEqual(toolGroupLabel(name: "read", count: 1), "Read a file")
        XCTAssertEqual(toolGroupLabel(name: "read", count: 2), "Read 2 files")
        XCTAssertEqual(toolGroupLabel(name: "write", count: 1), "Wrote a file")
        XCTAssertEqual(toolGroupLabel(name: "write", count: 2), "Wrote 2 files")
        XCTAssertEqual(toolGroupLabel(name: "edit", count: 1), "Made an edit")
        XCTAssertEqual(toolGroupLabel(name: "edit", count: 2), "Made 2 edits")
        XCTAssertEqual(toolGroupLabel(name: "glob", count: 1), "Searched")
        XCTAssertEqual(toolGroupLabel(name: "glob", count: 3), "Searched 3 times")
        XCTAssertEqual(toolGroupLabel(name: "grep", count: 1), "Searched")
        XCTAssertEqual(toolGroupLabel(name: "grep", count: 3), "Searched 3 times")
        XCTAssertEqual(toolGroupLabel(name: "ToolSearch", count: 1), "Loaded a tool")
        XCTAssertEqual(toolGroupLabel(name: "ToolSearch", count: 2), "Loaded 2 tools")
        XCTAssertEqual(toolGroupLabel(name: "Skill", count: 1), "Loaded a skill")
        XCTAssertEqual(toolGroupLabel(name: "Skill", count: 2), "Loaded 2 skills")
        XCTAssertEqual(toolGroupLabel(name: "ask_user", count: 1), "Asked a question")
        XCTAssertEqual(toolGroupLabel(name: "ask_user", count: 2), "Asked 2 questions")
        XCTAssertEqual(toolGroupLabel(name: "exit_plan_mode", count: 1), "Presented a plan")
        XCTAssertEqual(toolGroupLabel(name: "exit_plan_mode", count: 2), "Presented 2 plans")
        XCTAssertEqual(toolGroupLabel(name: "request_directory", count: 1), "Requested a directory")
        XCTAssertEqual(toolGroupLabel(name: "request_directory", count: 2), "Requested 2 directories")
    }

    func testToolGroupLabelUnrecognizedNameFallsBack() {
        XCTAssertEqual(toolGroupLabel(name: "mcp__foo__bar", count: 1), "Used a tool")
        XCTAssertEqual(toolGroupLabel(name: "mcp__foo__bar", count: 3), "Used 3 tools")
        XCTAssertEqual(toolGroupLabel(name: "some_future_tool", count: 1), "Used a tool")
    }
}
