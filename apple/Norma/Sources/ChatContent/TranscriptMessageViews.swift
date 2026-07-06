import AppKit
import SwiftUI

/// v1 bubble/markdown/code-block port (donor: `ChatRootView.swift:1571-1953` — `ChatMessageBubble`,
/// `ChatFormattedMessageText`, `ChatMarkdownBlockView`, `ChatCodeBlock`, copy helpers), adapted for
/// the transcript: our inputs are plain `String`/`ActivityItem` (no `ChatMessage`/`AppState`, no
/// image placeholders, no reasoning content, no tool arrays — those are v1-only concerns that
/// don't apply here), and colors are ADAPTIVE (assistant text `.primary`, labels `.secondary`,
/// activity rows `.tertiary`) instead of the donor's tint-driven scheme, per the task-3 brief.
/// No `.drawingGroup()` (v1 LAW) and no `repeatForever` animation anywhere below — this content
/// renders under the morph's scale/blur/opacity bands.

/// The user's own message — right-aligned tinted bubble, donor `ChatMessageBubble`'s `isUser` branch.
struct TranscriptUserBubble: View {
    let text: String
    let tint: Color

    private var displayText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        HStack(alignment: .bottom) {
            Spacer(minLength: 90)

            content
                .frame(maxWidth: 560, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("You")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)

            TranscriptFormattedMessageText(text: displayText, tint: tint, fillsAvailableWidth: false)
                .foregroundStyle(.primary)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(tint.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(tint.opacity(0.55), lineWidth: 0.5)
        )
    }
}

/// Norma's reply — left-aligned, full width, formatted blocks + a per-message copy affordance
/// that hides while the reply is still streaming (donor `ChatMessageBubble`'s non-user branch).
struct TranscriptAssistantMessage: View {
    let text: String
    let isStreaming: Bool

    @State private var isMessageCopyHovering = false
    @State private var didCopyMessage = false

    private var displayText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Norma")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)

                TranscriptFormattedMessageText(text: displayText, tint: .accentColor, fillsAvailableWidth: true)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if !isStreaming {
                Button {
                    copyMessageToPasteboard()
                } label: {
                    transcriptCopyLabel(didCopy: didCopyMessage, iconOnlyWhenIdle: true)
                        .frame(width: 68, height: 22, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(transcriptCopyForeground(isHovering: isMessageCopyHovering, didCopy: didCopyMessage))
                .onHover { isMessageCopyHovering = $0 }
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyMessageToPasteboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(displayText, forType: .string)
        showMessageCopiedFeedback()
    }

    private func showMessageCopiedFeedback() {
        didCopyMessage = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            didCopyMessage = false
        }
    }
}

/// Donor `ChatFormattedMessageText` — splits fenced code out via `FormattedMessageBlock.parse`,
/// renders remaining text as markdown blocks and code as `TranscriptCodeBlock`.
private struct TranscriptFormattedMessageText: View {
    let text: String
    let tint: Color
    let fillsAvailableWidth: Bool

    private var blocks: [FormattedMessageBlock] {
        FormattedMessageBlock.parse(text)
    }

    var body: some View {
        content
            .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block.kind {
                case .text(let content):
                    ForEach(MessageTextFormatter.chatMarkdownBlocks(content)) { markdownBlock in
                        TranscriptMarkdownBlockView(block: markdownBlock, tint: tint)
                    }
                case .code(let language, let code):
                    TranscriptCodeBlock(
                        language: language,
                        code: code,
                        tint: tint,
                        fillsAvailableWidth: fillsAvailableWidth
                    )
                }
            }
        }
    }
}

/// Donor `ChatMarkdownBlockView`, byte-identical structure/metrics — adaptive colors only:
/// paragraph/heading/bullet/numbered text use `.primary` via `formattedText`'s `.labelColor`
/// base (unchanged from the donor, which already used `.labelColor`), quote text is
/// `.secondary`, math background reads `.tertiary`-ish via `separatorColor` (unchanged from
/// donor — already adaptive).
private struct TranscriptMarkdownBlockView: View {
    let block: FormattedMarkdownBlock
    let tint: Color

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch block.kind {
        case .paragraph(let text):
            formattedText(text, size: 14, weight: .regular)
                .lineSpacing(3)
        case .heading(let level, let text):
            formattedText(text, size: headingSize(level), weight: headingWeight(level))
                .padding(.top, level <= 2 ? 4 : 2)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                formattedText(text, size: 14, weight: .regular)
                    .lineSpacing(3)
            }
        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(minWidth: 18, alignment: .trailing)
                formattedText(text, size: 14, weight: .regular)
                    .lineSpacing(3)
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(tint.opacity(0.42))
                    .frame(width: 3)
                formattedText(text, size: 13.5, weight: .regular)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
            }
            .padding(.vertical, 2)
        case .math(let text):
            Text(MessageTextFormatter.chatMathAttributedString(text))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(nsColor: .separatorColor).opacity(colorScheme == .dark ? 0.24 : 0.14))
                )
        }
    }

    private func formattedText(_ text: String, size: CGFloat, weight: NSFont.Weight) -> Text {
        let baseFont = NSFont.systemFont(ofSize: size, weight: weight)
        return Text(MessageTextFormatter.chatInlineAttributedString(
            text,
            colorScheme: colorScheme,
            baseFont: baseFont,
            codeFont: .monospacedSystemFont(ofSize: max(11.5, size - 0.5), weight: .regular),
            lineSpacing: 3
        ))
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 20
        case 2: return 17
        case 3: return 15.5
        default: return 14.5
        }
    }

    private func headingWeight(_ level: Int) -> NSFont.Weight {
        level <= 2 ? .semibold : .medium
    }
}

/// Donor `ChatCodeBlock`, ported as-is (horizontal scroll + syntax highlight + per-block copy) —
/// adaptive backgrounds/borders already used `NSColor` system colors in the donor, kept as-is.
private struct TranscriptCodeBlock: View {
    let language: String?
    let code: String
    let tint: Color
    let fillsAvailableWidth: Bool

    @Environment(\.colorScheme) private var colorScheme
    @State private var isCopyHovering = false
    @State private var didCopyCode = false
    @State private var isCodeBlockHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                HStack {
                    Text(language)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 12)

                    codeCopyButton
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 5)
            } else {
                HStack {
                    Spacer()
                    codeCopyButton
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 2)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(SyntaxHighlighter.highlighted(code, language: language, colorScheme: colorScheme))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, language == nil ? 10 : 8)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
        }
        .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(codeBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(codeBorderColor, lineWidth: isCodeBlockHovering ? 1 : 0.5)
        )
        .shadow(
            color: tint.opacity(isCodeBlockHovering ? 0.28 : 0),
            radius: isCodeBlockHovering ? 7 : 0,
            x: 0,
            y: 2
        )
        .scaleEffect(isCodeBlockHovering ? 1.006 : 1)
        .animation(.easeOut(duration: 0.14), value: isCodeBlockHovering)
        .onHover { isCodeBlockHovering = $0 }
    }

    private var codeCopyButton: some View {
        Button {
            copyCodeToPasteboard()
        } label: {
            transcriptCopyLabel(didCopy: didCopyCode, iconOnlyWhenIdle: false)
                .frame(width: 68, height: 22, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(transcriptCopyForeground(isHovering: isCopyHovering, didCopy: didCopyCode))
        .onHover { isCopyHovering = $0 }
    }

    private var codeBackground: Color {
        colorScheme == .dark
            ? Color.black.opacity(0.32)
            : Color(nsColor: .textBackgroundColor).opacity(0.72)
    }

    private var codeBorderColor: Color {
        if isCodeBlockHovering {
            return tint.opacity(0.55)
        }
        return Color(nsColor: .separatorColor).opacity(0.38)
    }

    private func copyCodeToPasteboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        showCodeCopiedFeedback()
    }

    private func showCodeCopiedFeedback() {
        didCopyCode = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            didCopyCode = false
        }
    }
}

/// Donor copy helpers (`copyLabel`/`copyForeground`, `ChatRootView.swift:1906-1922`) — adaptive
/// variant of the foreground: the donor forced `.white`/`.black` by color scheme; here the
/// idle/hover/copied states use `.secondary`/`.primary` so the control never fights the
/// surrounding adaptive text.
private func transcriptCopyLabel(didCopy: Bool, iconOnlyWhenIdle: Bool) -> some View {
    HStack(spacing: 5) {
        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
            .font(.system(size: 11, weight: .semibold))
        if didCopy || !iconOnlyWhenIdle {
            Text(didCopy ? "Copied" : "Copy")
                .font(.system(size: 11, weight: .medium))
        }
    }
}

private func transcriptCopyForeground(isHovering: Bool, didCopy: Bool) -> Color {
    (didCopy || isHovering) ? .primary : .secondary
}

// MARK: - Activity rows

/// Pure glyph/label mapper for one `ActivityItem` — no view/environment dependency so it's
/// directly unit-testable (`ActivityRowTests`). Kept exhaustive over `ActivityItem.Kind` so a
/// future case is a compile error here, not a silent blank row.
func activityGlyphAndLabel(_ item: ActivityItem) -> (glyph: String, label: String) {
    switch item.kind {
    case .tool(let name):
        return ("⚙", name)
    case .task(let subject, let status):
        return (taskGlyph(for: status), subject)
    case .subagent(let agentType):
        return ("⌥", agentType)
    case .subagentDone:
        return ("✓", "subagent done")
    case .worktree(let entered, let detail):
        return (entered ? "⛿" : "⟲", detail)
    case .interaction(let summary):
        return ("⚠", summary)
    }
}

private func taskGlyph(for status: String) -> String {
    switch status {
    case "in_progress": return "◐"
    case "completed": return "☑"
    default: return "☐" // pending, or any unrecognized status
    }
}

/// One line of "what happened" — donor has no equivalent (v1 never rendered per-turn activity);
/// this is new for the transcript, so it takes only the brief's explicit metrics: 11pt
/// `.tertiary`, single line, middle truncation (long tool args/paths keep both ends visible).
struct TranscriptActivityRow: View {
    let item: ActivityItem

    var body: some View {
        let mapped = activityGlyphAndLabel(item)
        HStack(spacing: 6) {
            Text(mapped.glyph)
            Text(mapped.label)
        }
        .font(.system(size: 11))
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

/// The "⏹ stopped" line shown when an exchange's turn ended via Esc-interrupt
/// (`Exchange.aborted`) — v1 parity companion to the activity rows, adaptive `.tertiary` text.
struct TranscriptStoppedRow: View {
    var body: some View {
        HStack(spacing: 6) {
            Text("⏹")
            Text("stopped")
        }
        .font(.system(size: 11))
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
}
