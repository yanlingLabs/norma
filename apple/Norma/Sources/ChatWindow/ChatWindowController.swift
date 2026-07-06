import AppKit
import SwiftUI

/// Esc routing for the chat window — same shape as the field's `escMonitorAction`
/// (OrbWindowController.swift): interrupt a running turn (window STAYS open so you can
/// watch the stopped feedback), otherwise close back to the orb. Pure for tests.
enum WindowEscAction: Equatable { case interrupt, close }

func windowEscAction(keyCode: UInt16, escConsumed: () -> Bool) -> WindowEscAction? {
    guard keyCode == 53 else { return nil }
    return escConsumed() ? .interrupt : .close
}

/// Phase 2d-i: the third surface. A stationary, draggable, near-opaque glass panel —
/// v1 transplant (AI pointer InteractionController.swift:800-1280,
/// `DetachedChatWindowController`), adapted: v2 has ONE window at a time (no UUID
/// registry), and the panel is created on `show` / destroyed on `close` (D9: closed
/// window = nil panel = zero cost; v1 kept its panels alive).
@MainActor
final class ChatWindowController: NSObject, NSWindowDelegate {
    private let session: SessionModel
    private let adapter: FieldStateAdapter
    private(set) var panel: ChatWindowPanel?
    private var keyMonitor: Any?

    /// Spec §2 position rule: nil until the user drags the window; then re-expands go here.
    private(set) var rememberedFrame: NSRect?
    /// Guards `windowDidMove` so ANIMATED/programmatic frame changes never pollute
    /// `rememberedFrame` — windowDidMove fires for those too, not just user drags.
    private var programmaticMove = false

    /// Grow-animation drive (deliberately NOT `NSAnimationContext`/`.animator().setFrame`):
    /// verified live that AppKit's implicit window-frame animation is unsafe here — a second
    /// `show()`/`close()` cycle starting while a PRIOR panel's animator-driven frame change is
    /// still in flight reliably crashes (SIGBUS, misaligned access deep in AppKit's animation
    /// machinery, reproduced standalone outside XCTest with a minimal two-panel repro; a single
    /// show+close in isolation never crashes). Rapid open/close — exactly what
    /// `ChatWindowControllerTests` does back-to-back, and a plausible real user click pattern —
    /// hits this every time. A manual 60Hz `Timer` interpolating the frame directly (same
    /// mechanism as `OrbWindowController`'s morph spring) reuses the existing `smoothstep`/
    /// `interpolatedRect` pure helpers (`Orb/MorphGeometry.swift`) for the same duration/easing
    /// feel, sidesteps AppKit's implicit-animation state entirely, and survived an 8-round
    /// rapid-fire torture test with zero crashes where the animator approach failed on round 2.
    private var growTimer: Timer?
    private var growStart: NSRect = .zero
    private var growTarget: NSRect = .zero
    private var growStartTime: CFTimeInterval = 0
    private let growDuration: CFTimeInterval = 0.30

    /// Gate fix (F1): true for the entire duration of the grow animation (the initial placement
    /// AND every 60Hz tick that follows), false otherwise. `panel.frameSanitizer` (installed in
    /// `show()`) reads this to bypass its normal 340×360 size floor while true — the grow's
    /// source is now the COLLAPSED ORB's small panel frame (`OrbWindowController.
    /// finishCollapse()`, ~240×140, sometimes smaller), which the floor would otherwise inflate
    /// to 340×360 on the very FIRST `setFrame`, killing the "grows from a tiny circle" effect
    /// this gate fix exists to restore. Position still gets clamped on-screen throughout (see
    /// `clampedChatWindowPosition`) — only the size floor is bypassed. Set true right before the
    /// grow's first `setFrame`, cleared in `cancelGrowAnimation()` (both the natural t>=1 finish
    /// and `close()`'s mid-flight cancel), same lifecycle as `programmaticMove`.
    private var isAnimatingGrow = false

    /// Spec §4: closing the window restores focus to the previously active app — the same
    /// snapshot/restore type the field uses (see OrbWindowController's `externalFocus`).
    private var externalFocus: ExternalFocusSnapshot?

    var onClose: (() -> Void)?
    var onEsc: (() -> Bool)?

    init(session: SessionModel, adapter: FieldStateAdapter) {
        self.session = session
        self.adapter = adapter
        super.init()
    }

    var isVisible: Bool { panel != nil }

    func show(from sourceFrame: NSRect) {
        guard panel == nil else { return }
        let screen = NSScreen.screens.first { $0.frame.intersects(sourceFrame) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let target = chatWindowTargetFrame(
            sourceFrame: sourceFrame, remembered: rememberedFrame,
            screenVisibleFrame: visible, defaultSize: chatWindowDefaultSize
        )

        // Panel construction: v1 transplant (InteractionController.swift:849-877), with
        // v2's orb collectionBehavior (adds .canJoinAllSpaces — proven above-fullscreen).
        //
        // Gate fix (F2 — real traffic lights + resizable): `.titled + .closable +
        // .miniaturizable + .resizable + .fullSizeContentView` gives the window the three
        // native system traffic-light buttons (native behavior/metrics, routed through OUR
        // teardown for close — see `windowShouldClose(_:)` below) and native edge-resizing,
        // while `.fullSizeContentView` still lets the SwiftUI content extend under the titlebar
        // so the glass tint reads as one continuous surface (`ChatWindowRootView`'s background
        // now bleeds to the window edge and relies on the SYSTEM window shape for corner
        // rounding — no more manual `.clipShape`, see that file's doc). `.nonactivatingPanel` is
        // KEPT alongside `.titled`: reasoned from AppKit docs (this combination is the standard
        // technique behind e.g. Spotlight-style/inspector panels that show real chrome without
        // stealing app activation) and empirically exercised by this file's own test suite
        // (`ChatWindowControllerTests` constructs/orders-front/closes this exact panel
        // repeatedly on a live WindowServer session with no crash/assertion) — if a future gate
        // finds it misbehaving live, drop `.nonactivatingPanel` here and note that the window
        // will then activate Norma on interaction (`ExternalFocusSnapshot` restore on close
        // already handles giving focus back).
        let panel = ChatWindowPanel(
            contentRect: target,
            styleMask: [
                .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView,
                .nonactivatingPanel,
            ],
            backing: .buffered,
            defer: false
        )
        panel.title = "Norma" // a11y/Dock — titleVisibility hides it from the (hidden) title bar text
        // Gate r2: Safari-style chrome (traffic lights inset in a taller bar + the larger
        // macOS 26 corner radius) comes from an empty unified toolbar — but a toolbar imposes
        // AppKit's own chrome-height frame minimums, which would inflate the grow animation's
        // tiny orb-sized start frame on the very first setFrame. So the panel is born
        // toolbar-less for the grow and gains the toolbar when the grow SETTLES — see
        // `attachChromeToolbar()`, called from `growTick`'s natural finish.
        panel.contentMinSize = NSSize(width: 340, height: 360) // native resize floor, matches the sanitizer's own
        panel.frameSanitizer = { [weak self] proposed, _ in
            // Gate fix (F1): bypass the SIZE floor while the grow animation is driving frames —
            // see `isAnimatingGrow`'s doc. Position still gets clamped on-screen either way.
            guard let self, !self.isAnimatingGrow else {
                return clampedChatWindowPosition(proposed, screenVisibleFrame: visible)
            }
            return clampedChatWindowFrame(proposed, screenVisibleFrame: visible)
        }
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true // opaque-looking window wants a real shadow (unlike the field)
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.acceptsMouseMovedEvents = true
        // Task-5 review catch: AppKit auto-hides key-capable panels when the app deactivates,
        // and Norma (accessory, non-activating panels) is "deactivated" almost always — without
        // this the window vanishes the moment the user clicks any other app, with close()/
        // onClose never firing. Same explicit opt-out the orb panel carries.
        panel.hidesOnDeactivate = false
        panel.delegate = self

        let hosting = NSHostingView(rootView: ChatWindowRootView(
            adapter: adapter,
            onRequestClose: { [weak self] in self?.close() }
        ))
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting
        self.panel = panel

        // Grow animation: start at the field's frame, animate to target. Donor pattern:
        // v1's placement move (InteractionController.swift:1091-1114) — v1's own show()
        // was instant; the grow is ours, per spec §2 handoff.
        // Captured BEFORE we take key: by this point the field's own hide() has already
        // restored ITS snapshot, so "current" is the app the user was really in.
        externalFocus = ExternalFocusSnapshot.captureCurrent()

        // Gate fix (F1): `sourceFrame` is now the COLLAPSED orb's own small panel frame
        // (`OrbWindowController.finishCollapse()`, ~240×140 — smaller than this window's own
        // 340×360 floor in both dimensions), not the field's old expanded frame. Deliberately
        // NOT pre-clamped through `clampedChatWindowFrame` here — that would inflate it to the
        // floor before the grow animation even starts. `isAnimatingGrow` makes the panel's own
        // `setFrame` override bypass that floor (position only, see `frameSanitizer` above) for
        // this placement and every tick that follows; read `panel.frame` back afterward so
        // `growStart` is the exact (position-clamped) frame actually on-screen at t=0, not the
        // raw un-clamped proposal.
        isAnimatingGrow = true
        programmaticMove = true
        panel.setFrame(sourceFrame, display: false)
        let startFrame = panel.frame
        panel.orderFrontRegardless()
        panel.makeKey()
        startGrowAnimation(from: startFrame, to: target)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, self.panel != nil, event.window === self.panel else { return event }
            switch windowEscAction(keyCode: event.keyCode, escConsumed: { self.onEsc?() == true }) {
            case .interrupt: return nil // turn interrupted; window stays (spec §4)
            case .close: self.close(); return nil
            case nil: return event
            }
        }
    }

    func close() {
        guard let panel else { return }
        cancelGrowAnimation()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
        panel.delegate = nil
        panel.orderOut(nil)
        self.panel = nil
        externalFocus?.restore()
        externalFocus = nil
        onClose?()
    }

    // MARK: Grow animation (manual — see `growTimer`'s doc for why not `.animator()`)

    private func startGrowAnimation(from start: NSRect, to end: NSRect) {
        growStart = start
        growTarget = end
        growStartTime = CACurrentMediaTime()
        growTimer?.invalidate()
        growTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.growTick() }
        }
    }

    private func growTick() {
        guard let panel, growTimer != nil else { return }
        let elapsed = CACurrentMediaTime() - growStartTime
        let t = max(0, min(1, elapsed / growDuration))
        let eased = smoothstep(0, 1, t)
        let frame = interpolatedRect(from: growStart, to: growTarget, progress: eased)
        panel.setFrame(frame, display: true)
        if t >= 1 {
            cancelGrowAnimation()
            attachChromeToolbar()
        }
    }

    /// Gate r2 (deferred from panel construction — see the comment in `show(from:)`): the empty
    /// unified toolbar that gives the settled window its Safari-style chrome. Attached only at
    /// the grow's NATURAL finish — a close() mid-grow never needs chrome, and re-shows rebuild
    /// the panel from scratch anyway.
    private func attachChromeToolbar() {
        guard let panel, panel.toolbar == nil else { return }
        let toolbar = NSToolbar(identifier: "norma.chatwindow.toolbar")
        toolbar.displayMode = .iconOnly
        panel.toolbar = toolbar
        panel.toolbarStyle = .unified
    }

    private func cancelGrowAnimation() {
        growTimer?.invalidate()
        growTimer = nil
        programmaticMove = false
        isAnimatingGrow = false // gate fix (F1): re-arm the sanitizer's size floor for real user/system frame changes
    }

    // MARK: NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        guard !programmaticMove, let frame = panel?.frame else { return }
        rememberedFrame = frame
    }

    /// Gate fix (F2 — resizable): native edge-resizing fires `windowDidResize`, not
    /// `windowDidMove` — mirrors that method's exact programmatic-move guard so a resize driven
    /// by the grow animation or `chatWindowTargetFrame` never pollutes `rememberedFrame`, only a
    /// real user drag of a resize handle does.
    func windowDidResize(_ notification: Notification) {
        guard !programmaticMove, let frame = panel?.frame else { return }
        rememberedFrame = frame
    }

    /// Gate fix (F2 — native traffic lights): the native red close button invokes this before
    /// AppKit's own close sequence runs. Route it through OUR teardown (`close()` — which fires
    /// `onClose` exactly once, restores focus, tears down the key monitor) and refuse AppKit's
    /// own close (`return false`) since we already tore the window down ourselves; `close()` is
    /// itself idempotent (guards on `panel` already being nil), so this can never double-fire
    /// `onClose` even if something else raced a close in first.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }

    /// Test seam for the drag-memory rule (unit tests can't synthesize a real user drag).
    func noteUserMovedWindowForTesting(to frame: NSRect) {
        rememberedFrame = frame
    }
}
