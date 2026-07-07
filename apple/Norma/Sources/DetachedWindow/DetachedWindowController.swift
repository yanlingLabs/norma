import AppKit
import SwiftUI

/// Task 3 (2d-ii-b): one detached chat window end-to-end — a REAL, native-chrome `NSWindow`
/// (native traffic lights, native resize, native Space/Mission-Control participation) hosting the
/// shared `WindowContentView` on its OWN `SessionFeed` (its own `NormaClient`/socket, pinned to one
/// session forever — spec's "harness-per-window"). Unlike the morph window
/// (`OrbWindowController`'s `.window` surface — a borderless, self-drawn, morphing panel), this
/// window NEVER morphs, so none of 2d-i's chrome-minimum constraints apply: it is a plain titled
/// window, and clicking it activates the app like any ordinary window (correct — this is detached
/// furniture, not the omnipresent orb).
///
/// Owns the window's whole lifecycle: construction at the handoff frame, the composer's
/// submit/steer wire (mirrors `GlassRootView.submit`'s success-gated draft clear), the Esc→
/// interrupt-only key monitor (a real window must never vanish on Esc), and the one-shot
/// `windowWillClose` teardown (`feed.stop()` + monitor removal + `onClosed`) shared by both the
/// programmatic `close()` path (app termination) and the user's own red traffic light.
@MainActor
final class DetachedWindowController: NSObject, NSWindowDelegate {
    private let feed: SessionFeed
    private let session: SessionModel
    private let window: NSWindow
    private let adapter: FieldStateAdapter

    /// The pinned session id this window's feed talks to — read once, at construction, off
    /// `feed.pinnedSessionId` (the only place that holds it; this controller's own init doesn't
    /// carry a separate sessionId parameter). `feed` is ALWAYS constructed in `.pinned` mode for a
    /// detached window (`AppModel.makeDetachedFeed`'s only mode) — an empty-string fallback with a
    /// logged contract-violation warning is defensive, not an expected path.
    private let sessionId: String

    private var escMonitor: Any?
    /// FINAL-REVIEW FIX (minor #3): the feed-start Task is stored so close can CANCEL it —
    /// `SessionFeed.start()`'s initial connect-backoff loop exits only on Task.isCancelled;
    /// without this, closing a window whose daemon never came up left the loop spinning
    /// (bounded at 10s backoff, but D9 says a closed window leaves NOTHING running).
    private var feedTask: Task<Void, Never>?
    /// One-shot latch: `windowWillClose` runs teardown + fires `onClosed` exactly once, whether it
    /// arrived via the programmatic `close()` (termination hook) or the user's red traffic light —
    /// both funnel through this same AppKit delegate callback.
    private var didClose = false

    /// Registry removal hook (`AppDelegate.registerDetachedWindow`) — fires exactly once.
    var onClosed: ((DetachedWindowController) -> Void)?

    /// Test-only read-through — lets tests assert on the constructed window's frame/styleMask
    /// without exposing `window` itself past this seam (same convention as
    /// `OrbWindowController.panelFrameForTesting`/`windowForTesting`-style accessors elsewhere).
    var windowForTesting: NSWindow? { window }

    /// Test-only read-through — lets tests drive `adapter.onSubmit`/inspect `composerDraft`
    /// directly (the real trigger, `ComposerTextView`'s `onSubmit`, isn't reachable from a unit
    /// test) without exposing the adapter as a general API surface on this controller.
    var adapterForTesting: FieldStateAdapter { adapter }

    /// - Parameters:
    ///   - frame: spawn exactly here (the morph window's frame at the moment of detach — task 4).
    ///   - title: the session's first prompt, clipped to ~40 chars, else "Norma" (a11y + the
    ///     Dock-minimize label a native titled window shows).
    init(feed: SessionFeed, session: SessionModel, frame: NSRect, title: String) {
        self.feed = feed
        self.session = session
        if let pinned = feed.pinnedSessionId {
            self.sessionId = pinned
        } else {
            OrbDebug.log("DetachedWindowController: feed has no pinned session id — contract violation (submit/interrupt will target an empty id)")
            self.sessionId = ""
        }

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.title = title
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        window.minSize = NSSize(width: 340, height: 360)
        window.backgroundColor = .clear
        window.isOpaque = false
        // LIVE-GATE W1b fix (Safari-style unified-toolbar technique, proven in this repo's
        // history around commit dd48b68): an empty toolbar + `.unified` style inserts the taller
        // titlebar band macOS gives a real toolbar window — traffic lights inset like Safari's
        // (~22pt, matching the morph window's own 14pt lights) instead of a bare titled window's
        // compact chrome, and macOS 26 gives that band the larger corner radius the morph
        // window's shell draws (26pt, `chatWindowCornerRadius`). AppKit enforces a chrome-minimum
        // frame (~40×220 observed historically) on toolbar windows, but that's irrelevant here:
        // `minSize` is already 340×360, and a detached window never animates open from a tiny
        // frame (unlike the morph panel), so there's no tiny-frame collision to guard against.
        let toolbar = NSToolbar(identifier: "norma.detached.toolbar")
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        self.window = window

        let adapter = FieldStateAdapter(session: session)
        self.adapter = adapter

        super.init()

        window.delegate = self
        adapter.onSubmit = { [weak self] text in self?.submit(text) }
        // FINAL-REVIEW FIX: [weak adapter] — the strong capture (GlassRootView's idiom) forms an
        // adapter→closure→adapter cycle. Harmless on the app-lifetime orb adapter, a REAL leak
        // here: detached windows create one adapter per window, and the cycle kept adapter +
        // SessionModel + its Combine sinks alive after every close (once per open/close cycle).
        adapter.onClearMessage = { [weak adapter] in adapter?.composerDraft = "" }
        window.contentView = NSHostingView(rootView: DetachedWindowRootView(adapter: adapter))
        window.setFrame(frame, display: true)
    }

    /// Orders the window front and starts its feed (connect/attach/pump — the same `SessionFeed`
    /// mechanics any pinned window uses); installs the Esc monitor. Idempotent-ish in practice:
    /// task 4 calls this exactly once per spawned controller.
    func show() {
        window.makeKeyAndOrderFront(nil)
        feedTask = Task { await feed.start() }
        installEscMonitor()
    }

    /// Programmatic close (the app-termination hook, `AppDelegate.applicationWillTerminate`) — goes
    /// through the SAME AppKit `windowWillClose` path the red traffic light does, so teardown only
    /// ever lives in one place.
    func close() {
        window.close()
    }

    private func installEscMonitor() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window else { return event }
            guard event.keyCode == 53 else { return event } // not Esc — pass through untouched
            guard self.session.state.turnRunning else { return event } // idle: pass through — NEVER close on Esc
            let client = self.feed.client
            let sid = self.sessionId
            Task { try? await client.interrupt(sessionId: sid) }
            return nil // consumed
        }
    }

    /// Mirrors `GlassRootView.submit`'s success-gated draft clear (GlassRootView.swift:~140–176):
    /// steer if this session's turn is already running, else send; the draft is cleared ONLY on
    /// success — a failed send/steer never loses the composed text.
    private func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let wasRunning = session.state.turnRunning
        let sid = sessionId
        let client = feed.client
        Task { @MainActor [weak self] in
            let ok: Bool
            if wasRunning {
                ok = (try? await client.steer(sessionId: sid, text: trimmed)) != nil
            } else {
                ok = (try? await client.send(sessionId: sid, text: trimmed)) != nil
            }
            if ok {
                self?.adapter.composerDraft = ""
            }
            // failure: text stays in the composer — the draft is never lost (spec §6 parity)
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        feedTask?.cancel()
        feedTask = nil
        feed.stop()
        if let escMonitor {
            NSEvent.removeMonitor(escMonitor)
            self.escMonitor = nil
        }
        onClosed?(self)
    }
}

/// The detached window's content: `WindowContentView` (shared with the morph window, task 2) over
/// a near-opaque tint + glass backdrop (reuses `chatWindowTint` — same approved values, no
/// progress-based fade-in here since this window never morphs, it's just always-on). Deliberately
/// NO `clipShape`/corner mask — the corner rounding comes for free from the SYSTEM window shape (a
/// real titled `NSWindow`), unlike the morph window's self-drawn `RoundedRectangle` shell. Content
/// bleeds up under the (hidden, transparent) native titlebar via the window's
/// `.fullSizeContentView` style mask + this view's `topInset: 52` (LIVE-GATE W1b: bumped from 40
/// to clear the TALLER unified-toolbar titlebar band the window construction above now attaches —
/// tune-at-gate constant).
struct DetachedWindowRootView: View {
    @ObservedObject var adapter: FieldStateAdapter
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        WindowContentView(
            adapter: adapter,
            tint: Color(red: 0.45, green: 0.75, blue: 1.0),
            topInset: 52
        ) {
            EmptyView()
        }
        .background {
            let t = chatWindowTint(darkMode: colorScheme == .dark)
            Rectangle()
                .fill(.regularMaterial)
                .overlay(Color(white: t.white).opacity(t.opacity))
        }
        .ignoresSafeArea()
    }
}
