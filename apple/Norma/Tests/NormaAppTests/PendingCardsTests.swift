import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 2 (2d-iii): the two PURE helpers behind the pending-interaction cards —
/// `questionAnswers(for:selections:otherTexts:)` (UI selection state → the answers dict the
/// daemon expects) and `cardTitle(_:)` (per-kind header text). Views themselves aren't rendered
/// here (nothing mounts `PendingCardsView` yet — that's Task 3); this only locks down the pure
/// mapping logic, same convention as `ActivityRowTests`/`PendingInteractionTests`.
final class PendingCardsTests: XCTestCase {
    /// Builds `[SessionEvent.Question]` the same wire-shaped-JSON way `PendingInteractionTests`
    /// does — `Question`/`QuestionOption` are cross-module `Codable` structs with no public
    /// memberwise initializer.
    func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    func testQuestionAnswersSingleSelect() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which db?": "Postgres"])
    }

    func testQuestionAnswersMultiSelectJoins() {
        let qs = questions(#"[{"question":"Which ports?","header":"Ports","options":[{"label":"80","description":null},{"label":"443","description":null},{"label":"8080","description":null}],"multiSelect":true}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0, 2]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which ports?": "80, 8080"])
    }

    func testOtherTextWinsOverSelection() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [0: "SQLite"])
        XCTAssertEqual(answers, ["Which db?": "SQLite"])
    }

    func testAnswersKeyedByQuestionText() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null},{"label":"443","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0], 1: [1]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which db?": "Postgres", "Which port?": "443"])
        XCTAssertEqual(answers.count, 2)
    }

    func testQuestionAnswersCountReflectsPartialAnswers() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        let partial = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [:])
        XCTAssertEqual(partial.count, 1)
        XCTAssertLessThan(partial.count, qs.count)

        let full = questionAnswers(for: qs, selections: [0: [0], 1: [0]], otherTexts: [:])
        XCTAssertEqual(full.count, qs.count)
    }

    // MARK: - questionCardComplete (whole-card Submit gate)

    func testQuestionCardCompleteFalseWhenUnanswered() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [:]))
    }

    func testQuestionCardCompleteFalseWhenPartiallyAnswered() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [0: [0]], otherTexts: [:]))
    }

    func testQuestionCardCompleteTrueWhenAllAnsweredBySelection() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [0: [0], 1: [0]], otherTexts: [:]))
    }

    func testQuestionCardCompleteTrueWhenAnsweredByOtherText() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [:], otherTexts: [0: "SQLite"]))
    }

    func testQuestionCardCompleteFalseWhenOtherTextIsWhitespaceOnly() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [0: "   "]))
    }

    func testQuestionCardCompleteSingleQuestionMatchesOneAnswerGate() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [:]))
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [0: [0]], otherTexts: [:]))
    }

    func testCardTitles() {
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        XCTAssertEqual(cardTitle(approval), "Approval needed — bash")

        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let question = PendingInteraction.question(callId: "q1", questions: qs)
        XCTAssertEqual(cardTitle(question), "DB")

        let plan = PendingInteraction.plan(callId: "p1", plan: "the plan")
        XCTAssertEqual(cardTitle(plan), "Plan for approval")
    }
}
