import XCTest

/// Exhaustive table test for `chargeLimitPlan` (SMCController.swift), the single source of truth
/// for the battery charge-limit decision. This file, plus HelperSources/SMCController.swift, are
/// given dual membership in the app test target (see project.yml) precisely so this pure function
/// is directly testable without pulling in the untestable IOKit surface or the XPC plumbing.
final class ChargeLimitPlanTests: XCTestCase {

    // MARK: Apple Silicon

    func test_appleSilicon_50_isCHWAOn() {
        XCTAssertEqual(chargeLimitPlan(percent: 50, appleSilicon: true), .writeCHWA(true))
    }

    func test_appleSilicon_80_isCHWAOn() {
        XCTAssertEqual(chargeLimitPlan(percent: 80, appleSilicon: true), .writeCHWA(true))
    }

    func test_appleSilicon_100_isCHWAOff() {
        XCTAssertEqual(chargeLimitPlan(percent: 100, appleSilicon: true), .writeCHWA(false))
    }

    func test_appleSilicon_81_isUnsupported() {
        XCTAssertEqual(chargeLimitPlan(percent: 81, appleSilicon: true), .unsupportedValue)
    }

    func test_appleSilicon_99_isUnsupported() {
        XCTAssertEqual(chargeLimitPlan(percent: 99, appleSilicon: true), .unsupportedValue)
    }

    func test_appleSilicon_49_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 49, appleSilicon: true), .invalidRange)
    }

    func test_appleSilicon_101_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 101, appleSilicon: true), .invalidRange)
    }

    // MARK: Intel

    func test_intel_50_isBCLM50() {
        XCTAssertEqual(chargeLimitPlan(percent: 50, appleSilicon: false), .writeBCLM(50))
    }

    func test_intel_75_isBCLM75() {
        XCTAssertEqual(chargeLimitPlan(percent: 75, appleSilicon: false), .writeBCLM(75))
    }

    func test_intel_100_isBCLM100() {
        XCTAssertEqual(chargeLimitPlan(percent: 100, appleSilicon: false), .writeBCLM(100))
    }

    func test_intel_49_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 49, appleSilicon: false), .invalidRange)
    }

    func test_intel_101_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 101, appleSilicon: false), .invalidRange)
    }
}
