import AppKit
import SwiftUI

/// Owns the orb panel. ARCHITECTURE NOTE (v1's converged lesson): this panel IS the future
/// field window's collapsed state — 2c expands it in place so the glassEffectID morph stays
/// inside one GlassEffectContainer. Do not add a second window for the field.
@MainActor
final class OrbWindowController {
    let follower = OrbFollower()
    private let panel: NSPanel
    private(set) var isVisible = false

    init(session: SessionModel) {
        // v1 PointerOverlayWindow configuration, verbatim.
        panel = NSPanel(
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
        isVisible = false
        follower.stop()
        panel.orderOut(nil)
    }

    func toggle() { isVisible ? hide() : show() }
}
