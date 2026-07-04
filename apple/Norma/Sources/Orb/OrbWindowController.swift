import AppKit
import SwiftUI

/// v1 PointerOverlayWindow's key/main refusal pattern (GlassFieldWindow.swift GlassFieldPanel,
/// verbatim): a borderless NSPanel defaults BOTH to true, and AppKit auto-promotes orderable
/// key-capable windows on close/deactivate/Space changes. Collapsed (orb) keeps 2b's refusal;
/// expanded (field) types.
private final class KeyableNonActivatingPanel: NSPanel {
    var acceptsKeyInput = false
    override var canBecomeKey: Bool { acceptsKeyInput }
    override var canBecomeMain: Bool { acceptsKeyInput }
}

/// Owns the orb/field panel. ARCHITECTURE NOTE (v1's converged lesson): this panel IS the future
/// field window's collapsed state — 2c expands it in place so the glassEffectID morph stays
/// inside one GlassEffectContainer. Do not add a second window for the field.
@MainActor
final class OrbWindowController: ObservableObject {
    enum Surface { case orb, field }

    let follower = OrbFollower()
    private let panel: KeyableNonActivatingPanel
    private(set) var isVisible = false
    @Published private(set) var surface: Surface = .orb

    /// Wired in Task 6: the controller exposes callbacks, it does NOT import AppModel.
    var onSubmit: ((String) -> Void)?
    var onInterrupt: (() -> Void)?
    /// Returns true when the key was consumed as an interrupt (turn running); false → collapse.
    var onEsc: (() -> Bool)?

    private var keyMonitor: Any?
    private var externalFocus: ExternalFocusSnapshot?

    init(session: SessionModel) {
        // v1 PointerOverlayWindow configuration, verbatim.
        panel = KeyableNonActivatingPanel(
            contentRect: NSRect(origin: .zero, size: OrbMetrics.windowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.ignoresMouseEvents = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.contentView = NSHostingView(rootView: OrbView(session: session))

        follower.onOrbCenterChange = { [weak self] center in
            guard let self, isVisible else { return }
            panel.setFrameOrigin(orbWindowOrigin(forOrbCenter: center, windowSize: OrbMetrics.windowSize))
        }
    }

    func show() {
        guard !isVisible else { return }
        isVisible = true
        panel.orderFrontRegardless()
        follower.start()
    }

    func hide() {
        guard isVisible else { return }
        if surface == .field { collapseToOrb() }
        isVisible = false
        follower.stop()
        panel.orderOut(nil)
    }

    func toggle() { isVisible ? hide() : show() }

    /// Expands the collapsed orb panel into the field: captures external focus, stops the
    /// follower (the field doesn't chase the cursor), computes the placement, makes the panel
    /// keyable and key, and installs the Esc-routing local monitor.
    func expandToField() {
        guard surface == .orb else { return }

        externalFocus = ExternalFocusSnapshot.captureCurrent()
        let orbCenter = follower.currentOrbCenter
        follower.stop()

        let visibleFrame = panel.screen?.visibleFrame ?? NSScreen.screens[0].visibleFrame
        let frame = fieldFrame(orbCenter: orbCenter, visibleFrame: visibleFrame)
        panel.setFrame(frame, display: true)
        panel.acceptsKeyInput = true
        panel.ignoresMouseEvents = false
        panel.makeKey()
        surface = .field

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, event.window === panel else { return event }
            if event.keyCode == 53 { // Esc
                if self.onEsc?() == true { return nil } // consumed as interrupt
                self.collapseToOrb()
                return nil
            }
            return event
        }

        OrbDebug.log("expandToField: frame=\(frame)")
    }

    /// Collapses the panel to orb size; removes the Esc monitor, un-keys the panel, and
    /// restores the captured external focus. The follower re-seeds from the CURRENT cursor
    /// position and positions the panel (the orb returns to wherever the cursor is now,
    /// not the pre-expansion point — deliberate UX).
    func collapseToOrb() {
        guard surface == .field else { return }

        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        panel.acceptsKeyInput = false
        panel.ignoresMouseEvents = true
        externalFocus?.restore()
        externalFocus = nil

        panel.setContentSize(OrbMetrics.windowSize)
        follower.start()
        surface = .orb

        OrbDebug.log("collapseToOrb")
    }

    func toggleField() {
        surface == .field ? collapseToOrb() : expandToField()
    }
}
