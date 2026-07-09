import AppKit
import XCTest
@testable import Norma

/// Task 4 (Phase 4d-iii) — the PURE parts only, same posture as `ShortcutRegistryTests`: conflict
/// detection (`bindingConflict`) and the modifier-flags→Carbon-mask mapping (`carbonModifiers`) the
/// key-capture control's callback builds a candidate `ShortcutBinding` from. The actual live
/// `keyDown` capture is glue, verified by the live gate, not here.
final class BindingConflictTests: XCTestCase {
    private func binding(plugin: String = "com.example.a", shortcut: String = "toggle", keyCode: UInt32 = 40, modifiers: UInt32 = 4096) -> ShortcutBinding {
        ShortcutBinding(pluginId: plugin, shortcutId: shortcut, keyCode: keyCode, modifiers: modifiers)
    }

    func testSameKeybindingOnTwoDifferentShortcutsIsAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 40, modifiers: 4096)
        XCTAssertTrue(bindingConflict(existing: existing, new: new))
    }

    func testDifferentKeybindingsAreNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 41, modifiers: 4096)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    func testDifferentModifiersOnTheSameKeyCodeAreNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 40, modifiers: 2048)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    /// Rebinding the SAME (pluginId, shortcutId) to a different key combo is not a self-conflict —
    /// even though `existing` still holds that pair's OLD binding at check time (the caller hasn't
    /// removed/replaced it yet).
    func testRebindingTheSamePluginShortcutIsNotASelfConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 41, modifiers: 8192)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    /// Re-applying the EXACT SAME binding for the same pair (a no-op save) is also not a conflict.
    func testReapplyingTheExactSameBindingIsNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = existing[0]
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    func testConflictIsDetectedAgainstAnyOneOfMultipleExistingBindings() {
        let existing = [
            binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096),
            binding(plugin: "com.example.b", shortcut: "open", keyCode: 12, modifiers: 2048),
        ]
        let new = binding(plugin: "com.example.c", shortcut: "close", keyCode: 12, modifiers: 2048)
        XCTAssertTrue(bindingConflict(existing: existing, new: new))
    }

    func testNoExistingBindingsIsNeverAConflict() {
        let new = binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)
        XCTAssertFalse(bindingConflict(existing: [], new: new))
    }
}

/// `carbonModifiers(from:)` — AppKit `NSEvent.ModifierFlags` → the Carbon modifier mask
/// `ShortcutBinding`/`RegisterEventHotKey` expect. Pure, no live event tap needed.
final class CarbonModifiersTests: XCTestCase {
    func testNoModifiersMapsToZero() {
        XCTAssertEqual(carbonModifiers(from: []), 0)
    }

    func testEachIndividualModifierMapsToItsOwnBit() {
        let control = carbonModifiers(from: .control)
        let option = carbonModifiers(from: .option)
        let shift = carbonModifiers(from: .shift)
        let command = carbonModifiers(from: .command)
        XCTAssertNotEqual(control, 0)
        XCTAssertNotEqual(option, 0)
        XCTAssertNotEqual(shift, 0)
        XCTAssertNotEqual(command, 0)
        // All four bits are distinct, so the OR below recovers all four with no overlap loss.
        XCTAssertEqual(Set([control, option, shift, command]).count, 4)
    }

    func testCombinedModifiersOrTogetherTheIndividualBits() {
        let combined = carbonModifiers(from: [.control, .option])
        let control = carbonModifiers(from: .control)
        let option = carbonModifiers(from: .option)
        XCTAssertEqual(combined, control | option)
    }

    func testIrrelevantModifierFlagsAreIgnored() {
        // `.capsLock`/`.function`/etc. have no Carbon hotkey-modifier equivalent this codebase
        // tracks — only control/option/shift/command are mapped.
        XCTAssertEqual(carbonModifiers(from: [.capsLock, .function]), 0)
    }
}
