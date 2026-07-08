import XCTest
@testable import Norma

/// gate-feedback-1 FIX A: the terminal-chat suppression gate on `GlassRootView`'s answer-arrival
/// auto-reveal. Two independent pure pieces get their own coverage:
///   - `isTerminalBundleIdentifier` (`TerminalFrontmost.swift`) — the frontmost-app allowlist.
///   - `isAutoRevealSuppressed`/`shouldAutoExpand` (`GlassRootView.swift`) — the suppression table
///     itself, composed with the pre-existing cursor-calm gate.
/// Manual summon (`OrbWindowController.toggleField()`) never calls `handleTurnCompleted()` at all
/// — see that method's doc — so it is intentionally NOT exercised here; there is nothing for this
/// suppression to affect on that path.
final class AutoRevealSuppressionTests: XCTestCase {

    // MARK: - isTerminalBundleIdentifier: the frontmost-app allowlist

    func testKnownTerminalBundleIdsAreRecognized() {
        for id in [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "dev.warp.Warp",
            "io.alacritty",
            "net.kovidgoyal.kitty",
            "com.github.wez.wezterm",
        ] {
            XCTAssertTrue(isTerminalBundleIdentifier(id), "\(id) should be recognized as a terminal")
        }
    }

    func testNonTerminalBundleIdsAreNotRecognized() {
        XCTAssertFalse(isTerminalBundleIdentifier("com.apple.finder"))
        XCTAssertFalse(isTerminalBundleIdentifier("com.norma.app"))
        XCTAssertFalse(isTerminalBundleIdentifier("com.apple.dt.Xcode"))
    }

    func testNilBundleIdIsNotATerminal() {
        XCTAssertFalse(isTerminalBundleIdentifier(nil))
    }

    // MARK: - isAutoRevealSuppressed: the pure suppression table — suppressed ONLY when BOTH hold

    func testSuppressedOnlyWhenBothConditionsHold() {
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: true))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: false))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: true))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: false))
    }

    // MARK: - shouldAutoExpand: suppression composed with the pre-existing calm-gate

    /// Suppression wins outright — `calm` is never consulted once BOTH suppression conditions hold,
    /// so even a calm cursor (which would normally auto-expand) does not.
    func testSuppressionOverridesCalmCursor() {
        XCTAssertFalse(shouldAutoExpand(calm: true, cliAttachedToFocused: true, frontmostIsTerminal: true))
    }

    /// Not suppressed (only one condition holds, or neither) — falls through to the ordinary
    /// calm-gate exactly as before this fix.
    func testUnsuppressedFallsThroughToCalmGate() {
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: false, frontmostIsTerminal: false))
        XCTAssertFalse(shouldAutoExpand(calm: false, cliAttachedToFocused: false, frontmostIsTerminal: false))
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: true, frontmostIsTerminal: false))
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: false, frontmostIsTerminal: true))
    }

    /// Full 2×2×2 truth table, spelled out explicitly so a future edit to the `&&` can't silently
    /// flip a corner without a test noticing.
    func testFullTruthTable() {
        let cases: [(calm: Bool, cli: Bool, terminal: Bool, expected: Bool)] = [
            (true,  false, false, true),
            (true,  true,  false, true),
            (true,  false, true,  true),
            (true,  true,  true,  false), // the ONLY suppressed-and-would-have-expanded case
            (false, false, false, false),
            (false, true,  false, false),
            (false, false, true,  false),
            (false, true,  true,  false),
        ]
        for c in cases {
            XCTAssertEqual(
                shouldAutoExpand(calm: c.calm, cliAttachedToFocused: c.cli, frontmostIsTerminal: c.terminal),
                c.expected,
                "calm=\(c.calm) cli=\(c.cli) terminal=\(c.terminal)"
            )
        }
    }
}
