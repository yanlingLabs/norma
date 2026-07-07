import SwiftUI
import NormaProtocol

/// Cards for outstanding approvals/questions/plans (2d-iii task 2) — PURE UI: consumes
/// `[PendingInteraction]` (task 1's typed reducer list) and injected response closures. NOTHING
/// mounts `PendingCardsView` yet — task 3 decides which surfaces show it and how it transitions
/// in/out (hence no `repeatForever`/looping animation anywhere below, and no scoped
/// `.transition`/`.animation` on the band itself — task 3's concern). Colors are ADAPTIVE
/// (`.primary`/`.secondary`/`.tertiary`) since the window is opaque, same convention as
/// `TranscriptMessageViews.swift` — no forced white, no `GlassForegroundLegibility`.

/// The pinned band. `respond` callbacks are injected (Task 3 wires them per-surface).
struct PendingCardsView: View {
    let interactions: [PendingInteraction]
    let inFlight: Set<String>                       // callIds with an RPC awaiting
    let errorLines: [String: String]                // callId → inline error text
    let onApproval: (String, Bool) -> Void          // callId, approved
    let onQuestion: (String, [String: String]) -> Void  // callId, answers (keyed by question text)
    let onPlan: (String, Bool, Bool, String?) -> Void   // callId, approved, autoAccept, feedback

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(interactions, id: \.callId) { interaction in
                PendingCard(
                    interaction: interaction,
                    isInFlight: inFlight.contains(interaction.callId),
                    errorLine: errorLines[interaction.callId],
                    onApproval: onApproval,
                    onQuestion: onQuestion,
                    onPlan: onPlan
                )
            }
        }
    }
}

// MARK: - Pure helpers (unit-tested — PendingCardsTests)

/// Maps the card's local per-question UI state to the answers dict `onQuestion` sends — keyed by
/// each question's own `question` text (not `header`, since two questions in the same ask can
/// share a header but never share question text). `selections`/`otherTexts` are keyed by the
/// question's index into `questions`. A question with no answer (empty selection AND empty/no
/// Other text) is simply omitted from the result — matches the CLI's own
/// `packages/cli/src/questions.ts` convention: multiSelect selections join their labels with
/// ", ", in option order; a non-empty Other text always wins over any selection for that
/// question (the user typed something more specific than the menu offered).
func questionAnswers(
    for questions: [SessionEvent.Question],
    selections: [Int: Set<Int>],
    otherTexts: [Int: String]
) -> [String: String] {
    var answers: [String: String] = [:]
    for (index, question) in questions.enumerated() {
        if let other = otherTexts[index]?.trimmingCharacters(in: .whitespacesAndNewlines), !other.isEmpty {
            answers[question.question] = other
            continue
        }
        guard let selected = selections[index], !selected.isEmpty else { continue }
        let labels = selected.sorted().compactMap { question.options.indices.contains($0) ? question.options[$0].label : nil }
        guard !labels.isEmpty else { continue }
        answers[question.question] = labels.joined(separator: ", ")
    }
    return answers
}

/// Per-kind card header text. Approval names the tool; a question card titles itself after its
/// FIRST question's `header` (a batch ask's later questions render their own `question` text
/// inline in the body — see `PendingQuestionBody`); a plan card's title is fixed (the plan text
/// itself, not a header field, is the body).
func cardTitle(_ interaction: PendingInteraction) -> String {
    switch interaction {
    case .approval(_, let toolName, _):
        return "Approval needed — \(toolName)"
    case .question(_, let questions):
        return questions.first?.header ?? ""
    case .plan:
        return "Plan for approval"
    }
}

/// The kind glyph shown in every card's header — ⚠ approval, ? question, ☰ plan.
private func cardGlyph(_ interaction: PendingInteraction) -> String {
    switch interaction {
    case .approval: return "⚠"
    case .question: return "?"
    case .plan: return "☰"
    }
}

// MARK: - Card chrome

/// One card: kind glyph + title header, per-kind body, optional inline error line — rounded-12
/// `.thinMaterial` section, consistent with the transcript's own material chrome
/// (`TranscriptView`'s "latest" pill, `TranscriptCodeBlock`).
private struct PendingCard: View {
    let interaction: PendingInteraction
    let isInFlight: Bool
    let errorLine: String?
    let onApproval: (String, Bool) -> Void
    let onQuestion: (String, [String: String]) -> Void
    let onPlan: (String, Bool, Bool, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(cardGlyph(interaction))
                    .foregroundStyle(.secondary)
                Text(cardTitle(interaction))
                    .foregroundStyle(.primary)
            }
            .font(.system(size: 13, weight: .semibold))

            cardBody

            if let errorLine {
                Text(errorLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var cardBody: some View {
        switch interaction {
        case .approval(let callId, _, let summary):
            PendingApprovalBody(callId: callId, summary: summary, isInFlight: isInFlight, onApproval: onApproval)
        case .question(let callId, let questions):
            PendingQuestionBody(callId: callId, questions: questions, isInFlight: isInFlight, onQuestion: onQuestion)
        case .plan(let callId, let plan):
            PendingPlanBody(callId: callId, plan: plan, isInFlight: isInFlight, onPlan: onPlan)
        }
    }
}

// MARK: - Approval card

/// Approval summary — monospaced 12pt, capped at 3 lines with an "expand" toggle when the text is
/// long enough to plausibly overflow that cap (SwiftUI gives no measured-line-count API short of
/// a `GeometryReader` round-trip, which is overkill here — a character-count heuristic is a fine
/// approximation: a false positive just shows a toggle whose "Show more" reveals nothing new).
private struct PendingApprovalBody: View {
    let callId: String
    let summary: String
    let isInFlight: Bool
    let onApproval: (String, Bool) -> Void

    @State private var isExpanded = false

    private var mightOverflowThreeLines: Bool {
        summary.count > 150 || summary.filter { $0 == "\n" }.count >= 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(isExpanded ? nil : 3)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if mightOverflowThreeLines {
                Button(isExpanded ? "Show less" : "Show more") {
                    isExpanded.toggle()
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                Button("Approve") { onApproval(callId, true) }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { onApproval(callId, false) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isInFlight)
        }
    }
}

// MARK: - Question card

/// One ask can carry 1-4 questions (`packages/core/src/agent/tools/ask-user.ts`); this body
/// renders all of them, accumulating selections/Other text across the WHOLE card in local state
/// so `questionAnswers` always computes the full, current dict — every answer affordance below
/// (an option button, a multiSelect Confirm, an Other Send) calls `submit()`, which re-derives and
/// forwards that whole-card dict, so the last one you interact with carries every answer you've
/// given so far. Task 3 owns de-duplication of repeat sends (via `inFlight`, once it flips true
/// for this callId after the first accepted answer).
private struct PendingQuestionBody: View {
    let callId: String
    let questions: [SessionEvent.Question]
    let isInFlight: Bool
    let onQuestion: (String, [String: String]) -> Void

    @State private var selections: [Int: Set<Int>] = [:]
    @State private var otherTexts: [Int: String] = [:]
    @State private var otherExpanded: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                QuestionBlock(
                    index: index,
                    question: question,
                    showsHeader: questions.count > 1,
                    selected: selections[index] ?? [],
                    otherText: otherTexts[index] ?? "",
                    isOtherExpanded: otherExpanded.contains(index),
                    isInFlight: isInFlight,
                    onSelectSingle: { optionIndex in
                        selections[index] = [optionIndex]
                        submit()
                    },
                    onToggleMulti: { optionIndex in
                        var current = selections[index] ?? []
                        if current.contains(optionIndex) { current.remove(optionIndex) } else { current.insert(optionIndex) }
                        selections[index] = current
                    },
                    onConfirmMulti: { submit() },
                    onExpandOther: { otherExpanded.insert(index) },
                    onOtherTextChange: { otherTexts[index] = $0 },
                    onSendOther: { submit() }
                )
            }
        }
    }

    private func submit() {
        onQuestion(callId, questionAnswers(for: questions, selections: selections, otherTexts: otherTexts))
    }
}

/// One question's options + Other row. Non-multiSelect renders plain option buttons (a click IS
/// the answer — matches the CLI's single-choice-per-click flow); multiSelect renders toggle rows
/// plus an explicit Confirm (there's no single click that unambiguously means "done picking").
private struct QuestionBlock: View {
    let index: Int
    let question: SessionEvent.Question
    let showsHeader: Bool
    let selected: Set<Int>
    let otherText: String
    let isOtherExpanded: Bool
    let isInFlight: Bool
    let onSelectSingle: (Int) -> Void
    let onToggleMulti: (Int) -> Void
    let onConfirmMulti: () -> Void
    let onExpandOther: () -> Void
    let onOtherTextChange: (String) -> Void
    let onSendOther: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsHeader {
                Text(question.header)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            Text(question.question)
                .font(.system(size: 13))
                .foregroundStyle(.primary)

            ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                optionRow(optionIndex, option)
            }

            if question.multiSelect {
                Button("Confirm", action: onConfirmMulti)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isInFlight)
            }

            otherRow
        }
    }

    @ViewBuilder
    private func optionRow(_ optionIndex: Int, _ option: SessionEvent.QuestionOption) -> some View {
        if question.multiSelect {
            Button {
                onToggleMulti(optionIndex)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: selected.contains(optionIndex) ? "checkmark.square.fill" : "square")
                        .foregroundStyle(selected.contains(optionIndex) ? Color.accentColor : .secondary)
                    optionLabel(option)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isInFlight)
        } else {
            Button {
                onSelectSingle(optionIndex)
            } label: {
                optionLabel(option)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isInFlight)
        }
    }

    private func optionLabel(_ option: SessionEvent.QuestionOption) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(option.label)
                .font(.system(size: 13))
                .foregroundStyle(.primary)
            if let description = option.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var otherRow: some View {
        if isOtherExpanded {
            HStack(spacing: 8) {
                TextField("Other…", text: Binding(get: { otherText }, set: onOtherTextChange))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                Button("Send", action: onSendOther)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isInFlight || otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        } else {
            Button("Other…", action: onExpandOther)
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .disabled(isInFlight)
        }
    }
}

// MARK: - Plan card

/// Plan body reuses the ii-a markdown block-rendering path via `TranscriptAssistantMessage`
/// (`ChatContent/TranscriptMessageViews.swift`) rather than duplicating it — `isStreaming: true`
/// suppresses that view's trailing per-message copy affordance (not part of this card's spec),
/// capped at ~260pt in a `ScrollView` since a plan can run long.
private struct PendingPlanBody: View {
    let callId: String
    let plan: String
    let isInFlight: Bool
    let onPlan: (String, Bool, Bool, String?) -> Void

    @State private var isRequestingChanges = false
    @State private var feedback = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                TranscriptAssistantMessage(text: plan, isStreaming: true)
            }
            .frame(maxHeight: 260)

            HStack(spacing: 8) {
                Button("Approve") { onPlan(callId, true, false, nil) }
                    .buttonStyle(.borderedProminent)
                Button("Approve + auto-accept") { onPlan(callId, true, true, nil) }
                    .buttonStyle(.bordered)
                Button("Request changes") { isRequestingChanges = true }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isInFlight)

            if isRequestingChanges {
                HStack(spacing: 8) {
                    TextField("What should change?", text: $feedback)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                    Button("Send") {
                        onPlan(callId, false, false, feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : feedback)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isInFlight)
                }
            }
        }
    }
}
