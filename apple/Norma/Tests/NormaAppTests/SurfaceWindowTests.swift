import XCTest
@testable import Norma

final class SummonToggleTests: XCTestCase {
    func testTapWithWindowOpenClosesIt() {
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: true), .closeWindow)
    }
    func testTapWithoutWindowTogglesField() {
        XCTAssertEqual(summonToggleAction(surface: .orb, windowVisible: false), .toggleField)
        XCTAssertEqual(summonToggleAction(surface: .field, windowVisible: false), .toggleField)
    }
    func testStaleWindowSurfaceWithNoPanelFallsBackToField() {
        // Belt: if surface says .window but the panel is gone, never wedge the summon path.
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: false), .toggleField)
    }
}

@MainActor
final class SurfaceWindowTests: XCTestCase {
    func testEnterWindowModeOnlyFromField() {
        let controller = OrbWindowController(session: SessionModel())
        var expanded: NSRect?
        controller.onExpandToWindow = { expanded = $0 }
        controller.enterWindowMode() // surface == .orb → illegal, no-op
        XCTAssertNil(expanded)
        XCTAssertEqual(controller.surface, .orb)
    }

    func testExitWindowModeRestoresOrb() {
        let controller = OrbWindowController(session: SessionModel())
        controller.setSurfaceForTesting(.window)
        controller.exitWindowMode()
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertTrue(controller.isVisible)
    }
}
