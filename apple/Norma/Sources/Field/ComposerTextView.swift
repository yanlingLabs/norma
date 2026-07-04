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
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = CommandTextView()
        textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: 14)
        textView.textColor = .labelColor
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
            .foregroundColor: NSColor.labelColor
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

        let window = textView.window
        if window?.firstResponder !== textView {
            DispatchQueue.main.async {
                _ = window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
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
