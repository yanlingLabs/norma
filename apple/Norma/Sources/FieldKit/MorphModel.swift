import Foundation
import CoreGraphics

/// DIRECT TRANSPLANT of v1's `MorphModel` (TextField/GlassFieldWindow.swift:263-334), the
/// spring-driven single source of truth for the orb → composer morph in v1. Every visual that
/// participates in the morph reads off `progress` (0…1): the glass shape grows from a small
/// bubble at the orb into a full rounded rectangle, content inside fades in late, the breathing
/// halo ramps its glow, and the orb window fades out on the same curve.
///
/// TASK A/B NAME COLLISION, NOW RESOLVED: task A (the additive port) had to name this type
/// `FieldKitMorphModel` and this file `FieldKitMorphModel.swift` because v2's flat "Norma" target
/// (project.yml: one `sources: [Sources]` entry) still declared the OLD thin approximation as
/// `Orb/MorphModel.swift`'s `final class MorphModel` at the time — two top-level types (and two
/// files) named `MorphModel` in one module is a redeclaration error. Task B (this swap) deletes
/// that old approximation, so both the type and this file are renamed back to `MorphModel` /
/// `MorphModel.swift` here, per task A's report.
///
/// CUT vs v1 (dashboard/chat surfaces don't exist post-transplant — only the composer path is
/// ported): `surface: GlassFieldSurface`, `dashboardOrbPoint`, `dashboardFinalRect`,
/// `chatPlacement`, `isChatSidebarCollapsed`, `chatSurfaceMotionBlur`, `dashboardContentSize`,
/// `dashboardWindowSize`, `dashboardCornerRadius` are all dropped — nothing in the composer path
/// (v1 GlassFieldView.composerBody) reads `morph.surface` or any dashboard/chat member (verified
/// by grep: the only reads of `.surface` inside GlassFieldView.swift are in `body`'s dashboard/
/// chat routing, GlassFieldView.swift:299/301, both outside composerBody). `screenshotPillHeight`
/// / `screenshotPillWidth` are also dropped — images/screenshots are cut per the brief.
@MainActor
final class MorphModel: ObservableObject {
    /// 0 = fully orb (tiny bubble centered on the cursor companion),
    /// 1 = fully expanded composer pill docked at the chosen corner. Only the
    /// composer pill (reset icon + text field) participates in this morph —
    /// the nav pill spawns separately as a secondary fade-in.
    @Published var progress: Double = 0
    /// True only for the orb -> field leg. The orb glass tint should not
    /// reappear during field -> orb collapse as progress approaches zero.
    @Published var isOpening: Bool = true
    /// Which corner of the composer pill sits over the orb. Task B (window choreography + edge
    /// fence) pins this at `.topLeft` FOREVER by user directive — v1's per-corner switching
    /// (`FieldCorner.choose`) is replaced by continuously fencing the tracking spring's TARGET
    /// anchor instead (`fenceAnchorForTopLeftCorner`, `FieldKit/FieldCorner.swift`), so the
    /// expanded frame always fits on-screen without ever needing a different corner.
    @Published var corner: FieldCorner = .topLeft
    /// Current height of the composer pill. Starts at a single-line height
    /// and grows as the user types (or wraps). Updated by the SwiftUI view
    /// from the composer's reported content height.
    @Published var composerHeight: CGFloat = 44
    /// Wave-5 gate item 3: natural (unclamped) height of the inline response's own content —
    /// pinned/live prompt + reply + the queued-steer line, whichever are showing — measured live
    /// by `NormaFieldView.inlineResponse` via a background `GeometryReader` + `PreferenceKey`
    /// (mirrors `composerHeight`'s doc above / `composerContentHeight`'s actual live mechanism,
    /// ported to the read side since there's no NSTextView to report it here). Drives the shell
    /// height while a response is showing (`NormaFieldView.clampedResponseHeight(in:)`), clamped
    /// to the window's own usable vertical space so the pill never grows past the halo padding —
    /// anything taller keeps scrolling internally, same as before this wave.
    @Published var responseHeight: CGFloat = 0
    /// Incremented when macOS moves the panel into a new compositor context
    /// (Space/screen changes). Rebuilding the glass subtree forces SwiftUI's
    /// native Liquid Glass backing view to reacquire refraction/shadow state.
    @Published var glassRefreshGeneration = 0

    /// Outer window size. Sized to fit nav pill + composer + screenshot pill
    /// slot + generous halo padding on every side so the breathing glow never
    /// hits the window edge and hard-cuts. Task B: this is the AppKit panel's
    /// real frame size while `OrbWindowController.surface == .field` (from the
    /// instant an expand starts until a collapse fully settles) — see
    /// `OrbWindowController.expandToField()`/`finishCollapse()`.
    let windowSize = CGSize(width: 480, height: 440)
    /// Compact panel size used while the UI is collapsed to the cursor orb.
    /// The same SwiftUI glass remains alive; only the AppKit container
    /// shrinks so the idle state is not a full-screen-sized transparent panel.
    /// Task B: this is the AppKit panel's real frame size whenever
    /// `OrbWindowController.surface == .orb`.
    let collapsedWindowSize = CGSize(width: 240, height: 140)

    /// GATE-3 FIX (F1, root cause #2): which of `collapsedWindowSize`/`windowSize` the AppKit
    /// panel is ACTUALLY sized to right now — `NormaFieldView.body` requests this as its outer
    /// `.frame(...)`, instead of unconditionally requesting `windowSize`. Root cause: `
    /// NSHostingView` resizes its own window to match its SwiftUI content's requested frame on
    /// every `windowDidLayout` (confirmed live via a symbolicated stack trace —
    /// `NSHostingView.windowDidLayout()` → `updateAnimatedWindowSize(_:)` →
    /// `-[NSWindow _setFrameCommon:display:fromServer:]`; this fires unconditionally, it is NOT
    /// gated by `NSHostingView.sizingOptions`). With the outer frame permanently requesting the
    /// full 480×440 `windowSize`, that mechanism silently grew the panel back to 480×440 on the
    /// very first layout pass — even at boot, before any expand was ever triggered — undoing the
    /// 240×140 `contentRect` `OrbWindowController.init` constructs the panel with and every later
    /// `panel.setFrame(..., size: collapsedWindowSize)` call (`finishCollapse()`). Since the
    /// composer's visible geometry already morphs off `progress` independent of this outer frame
    /// (see `NormaFieldView`'s own doc — the frame only changes at the two hard resize instants,
    /// never mid-morph), keeping this in lockstep with `OrbWindowController`'s own two
    /// `panel.setFrame` calls (`expandToField()`/`finishCollapse()`) makes NSHostingView's
    /// auto-resize AGREE with our explicit sizing instead of fighting it.
    @Published var activeWindowSize: CGSize = CGSize(width: 240, height: 140)
    /// Composer pill width. Height is dynamic (`composerHeight`).
    let composerWidth: CGFloat = 360
    /// Initial / minimum composer height — matches a single line of text
    /// plus the wrapping pill chrome.
    let composerMinHeight: CGFloat = 44
    /// Collapsed glass bubble size used for the orb end of the morph.
    /// Kept separate from composerMinHeight so the resting orb can be
    /// smaller without making the text field too short.
    let orbBubbleSize: CGFloat = 20
    /// Hard cap on composer height before internal scrolling kicks in, so
    /// the pill never grows past its slot in the window.
    let composerMaxHeight: CGFloat = 240
    /// Nav pill final size. Width is intrinsic (shrinkwrap around its
    /// contents) but we keep a max so the layout stays tidy.
    let navPillMaxWidth: CGFloat = 300
    let navPillHeight: CGFloat = 34
    /// Space between the composer pill and the nav pill.
    let interPillGap: CGFloat = 8
    /// Gap between the glass elements and the window edge — reserved for
    /// the breathing halo to bloom into without clipping.
    let haloPadding: CGFloat = 60
}
