import XCTest
@testable import Norma

/// LIVE-GATE G3 / r1b: pure grouping/label/sentence logic for the transcript's grouped tool
/// lines. Drives `groupActivity`/`toolGroupFragment`/`toolGroupLabel`/`toolRunSentence` directly
/// (no view involved) — mirrors `ActivityRowTests`' convention of testing the pure mapper, not
/// the SwiftUI body. r1b (CC parity): an unbroken run of tool calls, even across DIFFERENT tool
/// names, collapses to ONE comma-joined sentence row — `groupActivity` now emits `.toolRun`
/// groups of `ToolRunEntry` directly instead of r1's single-name `.tools` case.
final class ActivityGroupingTests: XCTestCase {
    private func tool(_ name: String, _ detail: String? = nil) -> ActivityItem {
        ActivityItem(kind: .tool(name: name, detail: detail))
    }

    // MARK: groupActivity

    func testConsecutiveSameNameToolsMergeIntoOneEntry() {
        let items = [tool("bash", "ls"), tool("bash", "pwd"), tool("bash", nil)]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", count: 3, details: ["ls", "pwd"])]),
        ])
    }

    func testDifferentToolNamesStayInOneRunAsSeparateEntries() {
        // r1b: an unbroken run spans different tool names — one `.toolRun` group, two entries,
        // NOT two separate groups (that was r1's behavior).
        let items = [tool("bash", "ls"), tool("read", "/tmp/x")]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([
                ToolRunEntry(name: "bash", count: 1, details: ["ls"]),
                ToolRunEntry(name: "read", count: 1, details: ["/tmp/x"]),
            ]),
        ])
    }

    func testNonConsecutiveSameNameWithinARunStaysAsSeparateEntries() {
        // bash, read, bash — all one unbroken run, but the two bash calls aren't adjacent so they
        // don't merge into a single entry (matches r1's "consecutive only" merge rule).
        let items = [tool("bash", "ls"), tool("read", "/a"), tool("bash", "pwd")]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([
                ToolRunEntry(name: "bash", count: 1, details: ["ls"]),
                ToolRunEntry(name: "read", count: 1, details: ["/a"]),
                ToolRunEntry(name: "bash", count: 1, details: ["pwd"]),
            ]),
        ])
    }

    func testNonToolItemBreaksARunEvenIfToolsResumeAfter() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .interaction("needs approval")),
            tool("bash", "pwd"),
        ]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", count: 1, details: ["ls"])]),
            .single(ActivityItem(kind: .interaction("needs approval"))),
            .toolRun([ToolRunEntry(name: "bash", count: 1, details: ["pwd"])]),
        ])
    }

    func testTaskItemsAreSkippedEntirely() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            tool("bash", "pwd"),
        ]
        // The task item vanishes from grouping — AND, since it's skipped rather than treated as a
        // run-breaker, the two bash calls on either side of it still merge into one entry.
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", count: 2, details: ["ls", "pwd"])]),
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
            .toolRun([ToolRunEntry(name: "read", count: 4, details: ["/a", "/b"])]),
        ])
    }

    func testEmptyInputYieldsEmptyOutput() {
        XCTAssertEqual(groupActivity([]), [])
    }

    // MARK: toolGroupFragment (lowercase, sentence-building unit)

    func testToolGroupFragmentSingularPlural() {
        XCTAssertEqual(toolGroupFragment(name: "bash", count: 1), "ran a shell command")
        XCTAssertEqual(toolGroupFragment(name: "bash", count: 3), "ran 3 shell commands")
        XCTAssertEqual(toolGroupFragment(name: "task_create", count: 1), "created a task")
        XCTAssertEqual(toolGroupFragment(name: "task_create", count: 4), "created 4 tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_update", count: 1), "updated a task")
        XCTAssertEqual(toolGroupFragment(name: "task_update", count: 2), "updated 2 tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_list", count: 1), "checked tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_list", count: 5), "checked tasks")
        XCTAssertEqual(toolGroupFragment(name: "read", count: 1), "read a file")
        XCTAssertEqual(toolGroupFragment(name: "read", count: 2), "read 2 files")
        XCTAssertEqual(toolGroupFragment(name: "write", count: 1), "wrote a file")
        XCTAssertEqual(toolGroupFragment(name: "write", count: 2), "wrote 2 files")
        XCTAssertEqual(toolGroupFragment(name: "edit", count: 1), "made an edit")
        XCTAssertEqual(toolGroupFragment(name: "edit", count: 2), "made 2 edits")
        XCTAssertEqual(toolGroupFragment(name: "ToolSearch", count: 1), "loaded a tool")
        XCTAssertEqual(toolGroupFragment(name: "ToolSearch", count: 2), "loaded 2 tools")
        XCTAssertEqual(toolGroupFragment(name: "Skill", count: 1), "loaded a skill")
        XCTAssertEqual(toolGroupFragment(name: "Skill", count: 2), "loaded 2 skills")
        XCTAssertEqual(toolGroupFragment(name: "ask_user", count: 1), "asked a question")
        XCTAssertEqual(toolGroupFragment(name: "ask_user", count: 2), "asked 2 questions")
        XCTAssertEqual(toolGroupFragment(name: "exit_plan_mode", count: 1), "presented a plan")
        XCTAssertEqual(toolGroupFragment(name: "exit_plan_mode", count: 2), "presented 2 plans")
        XCTAssertEqual(toolGroupFragment(name: "request_directory", count: 1), "requested a directory")
        XCTAssertEqual(toolGroupFragment(name: "request_directory", count: 2), "requested 2 directories")
    }

    func testToolGroupFragmentGlobRelabeledToListedGrepStaysSearched() {
        // r1b: `glob` relabels from "searched" to "listed a/N directories" — Norma has no `ls`
        // tool, `glob` is the lister. `grep` keeps "searched".
        XCTAssertEqual(toolGroupFragment(name: "glob", count: 1), "listed a directory")
        XCTAssertEqual(toolGroupFragment(name: "glob", count: 2), "listed 2 directories")
        XCTAssertEqual(toolGroupFragment(name: "grep", count: 1), "searched")
        XCTAssertEqual(toolGroupFragment(name: "grep", count: 3), "searched 3 times")
    }

    func testToolGroupFragmentUnrecognizedNameFallsBack() {
        XCTAssertEqual(toolGroupFragment(name: "mcp__foo__bar", count: 1), "used a tool")
        XCTAssertEqual(toolGroupFragment(name: "mcp__foo__bar", count: 3), "used 3 tools")
        XCTAssertEqual(toolGroupFragment(name: "some_future_tool", count: 1), "used a tool")
    }

    // MARK: toolGroupLabel (capitalized single-fragment — r1 continuity)

    func testToolGroupLabelCapitalizesTheFragment() {
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 1), "Ran a shell command")
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 3), "Ran 3 shell commands")
        XCTAssertEqual(toolGroupLabel(name: "glob", count: 1), "Listed a directory")
        XCTAssertEqual(toolGroupLabel(name: "glob", count: 3), "Listed 3 directories")
        XCTAssertEqual(toolGroupLabel(name: "grep", count: 1), "Searched")
        XCTAssertEqual(toolGroupLabel(name: "mcp__foo__bar", count: 1), "Used a tool")
    }

    // MARK: toolRunSentence

    func testSentenceForSingleEntryRunMatchesOldSimpleLabel() {
        let entries = [ToolRunEntry(name: "bash", count: 3, details: ["ls", "pwd", "echo"])]
        XCTAssertEqual(toolRunSentence(entries), toolGroupLabel(name: "bash", count: 3))
        XCTAssertEqual(toolRunSentence(entries), "Ran 3 shell commands")
    }

    func testSentenceCombinesMultipleEntriesCommaJoinedFirstCapitalizedRestLowercase() {
        // CC screenshot said "Read 4 files, listed 1 directory, ran 8 shell commands" — but Norma's
        // own singular convention (matching every other verb: "a file" not "1 file") renders a
        // count of exactly 1 as "a directory", so the count-1 fragment here is "listed a directory".
        let entries = [
            ToolRunEntry(name: "read", count: 4, details: []),
            ToolRunEntry(name: "glob", count: 1, details: []),
            ToolRunEntry(name: "bash", count: 8, details: []),
        ]
        XCTAssertEqual(toolRunSentence(entries), "Read 4 files, listed a directory, ran 8 shell commands")
    }

    func testSentenceWithMultipleDirectoriesUsesTheCountedForm() {
        let entries = [
            ToolRunEntry(name: "read", count: 4, details: []),
            ToolRunEntry(name: "glob", count: 2, details: []),
            ToolRunEntry(name: "bash", count: 8, details: []),
        ]
        XCTAssertEqual(toolRunSentence(entries), "Read 4 files, listed 2 directories, ran 8 shell commands")
    }

    func testSentenceForEmptyRunIsEmptyString() {
        XCTAssertEqual(toolRunSentence([]), "")
    }

    // MARK: detail concatenation order (TranscriptToolGroupRow's expansion is view-level, but the
    // ordering it renders comes straight from `ToolRunEntry.details`/entry order — verify the
    // model here, not the view.)

    func testEntryDetailsAndEntryOrderTogetherGiveFullRunDetailOrder() {
        let items = [
            tool("read", "/a"), tool("read", "/b"),
            tool("glob", "*.swift"),
            tool("bash", "ls"), tool("bash", nil), tool("bash", "pwd"),
        ]
        guard case .toolRun(let entries)? = groupActivity(items).first else {
            return XCTFail("expected a single .toolRun group")
        }
        let detailLines = entries.flatMap { entry in entry.details.map { "\(entry.name) \($0)" } }
        XCTAssertEqual(detailLines, [
            "read /a", "read /b",
            "glob *.swift",
            "bash ls", "bash pwd",
        ])
    }
}
