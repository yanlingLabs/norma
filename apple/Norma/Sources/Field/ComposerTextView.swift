import AppKit
import SwiftUI

/// v1 port (TextField/ComposerTextView.swift, 437 lines), stripped for 2c's text-only field:
/// every `ComposerImageItem`/image-paste path and `SelectedTextContext` reference is gone (no
/// paste override, no appearanceStyle/accentColor/isEditable/caret-line-navigation surface —
/// those existed to support v1's image chips and cross-widget arrow-key navigation, neither of
/// which apply here). What's kept, verbatim in spirit:
///   - `doCommand(by:)` Enter-submits / Shift+Enter-inserts-newline (v1 CommandTextView:418-430).
///   - NSScrollView wrapping the NSTextView (D7: no custom scrollWheel — the scroll view does
///     the work natively).
///   - Focus plumbing: simplified from v1's `isFocused` binding (driven by a focus coordinator
///     that doesn't exist in 2c) to "always try to become first responder" — the field has
///     exactly one editable surface, so there's no cross-widget focus to arbitrate.
///   - Placeholder rendering: moved OUT of this view into `FieldView`, which overlays a plain
///     SwiftUI `Text` when `text.isEmpty` — v1 didn't have composer placeholder text at all
///     (its "placeholder" was an image-capture pill), so there's no v1 shape to port here.
///
/// Task B (v1 field transplant, window choreography) adds back v1's `onContentHeightChange`
/// (`TextField/ComposerTextView.swift:39,301-315`, verbatim measurement: laid-out text height
/// via `NSLayoutManager.usedRect(for:)` plus the container's vertical insets, deduped to >0.5pt
/// changes) so `NormaFieldView`'s composer pill can grow with typed/wrapped text instead of
/// sitting fixed at `composerMinHeight`.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var onSubmit: () -> Void
    var onContentHeightChange: (CGFloat) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = CommandTextView()
        textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: 14)
        // GATE-3 FIX (F2): this composer is rendered inside `NormaFieldView.composerOrResponseContent`,
        // which is wrapped in `.modifier(GlassForegroundLegibility())` — `.blendMode(.difference)`
        // against the glass surface beneath (see that type + `GlassChromeColor`'s doc). Difference
        // inverts cleanly ONLY against a pure-white source (`white − bg = inverse(bg)`); v1's own
        // `composerForegroundColor` (TextField/ComposerTextView.swift) hardcodes `.white` for exactly
        // this reason and documents the failure mode by name: "`.labelColor` would be ... already the
        // inverse of the typical glass tone — so subtracting it from the background would produce
        // near-white in both modes (the washed-out 'full white' symptom)" — i.e. typed text renders
        // invisible. `.labelColor` here was the transplant regression; `.white` restores v1 parity.
        textView.textColor = .white
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.typingAttributes = [
            .font: textView.font ?? .systemFont(ofSize: 14),
            .foregroundColor: NSColor.white
        ]
        textView.insertionPointColor = .controlAccentColor
        textView.string = text
        textView.onSubmit = onSubmit

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.documentView = textView

        DispatchQueue.main.async { [weak textView] in
            guard let textView else { return }
            _ = textView.window?.makeFirstResponder(textView)
            context.coordinator.reportHeight(textView)
        }
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? CommandTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        if textView.string != text {
            textView.string = text
        }
        textView.textContainer?.containerSize = NSSize(
            width: max(1, nsView.contentSize.width),
            height: .greatestFiniteMagnitude
        )
        context.coordinator.reportHeight(textView)

        let window = textView.window
        if window?.firstResponder !== textView {
            DispatchQueue.main.async {
                _ = window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        private var lastReportedHeight: CGFloat = -1

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            reportHeight(textView)
        }

        /// v1 port (`TextField/ComposerTextView.swift:301-315`, verbatim measurement): the
        /// laid-out text height plus the container's vertical insets, so the composer starts
        /// single-line and grows as the user writes instead of reserving multi-line space up
        /// front. Deduped (>0.5pt) so tiny rounding jitter doesn't spam `onContentHeightChange`.
        func reportHeight(_ textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let container = textView.textContainer else { return }
            layoutManager.ensureLayout(for: container)
            let usedRect = layoutManager.usedRect(for: container)
            let insetsHeight = textView.textContainerInset.height * 2
            let height = ceil(usedRect.height + insetsHeight)
            guard abs(height - lastReportedHeight) > 0.5 else { return }
            lastReportedHeight = height
            DispatchQueue.main.async { [weak self] in
                self?.parent.onContentHeightChange(height)
            }
        }
    }
}

/// v1 port of `CommandTextView` (TextField/ComposerTextView.swift:333-437), stripped to just
/// the Enter/Shift+Enter `doCommand(by:)` override — the paste-image interception and
/// selection-change reporting are gone with the image/caret-navigation surface above.
final class CommandTextView: NSTextView {
    var onSubmit: (() -> Void)?

    override func doCommand(by selector: Selector) {
        switch selector {
        case #selector(insertNewline(_:)):
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                super.doCommand(by: selector)
            } else {
                onSubmit?()
            }
        default:
            super.doCommand(by: selector)
        }
    }
}
