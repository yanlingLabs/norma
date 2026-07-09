import XCTest
@testable import Norma

/// Task 2 (Phase 4d-iii): `pluginRowDisplay(...)` — the PURE `plugins.list` entry → row-display
/// mapping (tier badge / version / consent text / status text+color / action set). No
/// `NormaClient`, no SwiftUI — same "pure helper, table-tested directly" posture as
/// `DashboardTests`' coverage of `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths`.
final class PluginManagerModelTests: XCTestCase {
    /// Convenience default-args wrapper so each test below only spells out the fields it's
    /// actually varying.
    private func row(
        name: String = "sample-echo",
        version: String? = "1.2.0",
        tier: String? = "platform",
        requiredConsents: [String] = [],
        consented: [String] = [],
        legacy: Bool = false,
        status: String? = "running",
        disabled: Bool = false
    ) -> PluginRowDisplay {
        pluginRowDisplay(
            name: name, version: version, tier: tier, requiredConsents: requiredConsents,
            consented: consented, legacy: legacy, status: status, disabled: disabled
        )
    }

    // MARK: - Action rule: running Tier-2 → [.restart, .disable, .remove]

    func testRunningTier2EnabledGetsRestartDisableRemove() {
        let r = row(tier: "platform", status: "running", disabled: false)
        XCTAssertEqual(r.tierBadge, "Tier 2")
        XCTAssertEqual(r.statusText, "Running")
        XCTAssertEqual(r.statusColorKind, .running)
        XCTAssertEqual(r.actions, [.restart, .disable, .remove])
    }

    /// The central "never offer .enable for an already-running plugin" carryover from 4d-ii —
    /// enabling a running plugin bounces it.
    func testNeverOffersEnableForARunningPlugin() {
        let r = row(status: "running", disabled: false)
        XCTAssertFalse(r.actions.contains(.enable))
    }

    // MARK: - Action rule: `.restart` ONLY for a running Tier-2 plugin — every other enabled,
    // non-running Tier-2 runtime state (stopped/backoff/circuit-open/starting) gets
    // [.disable, .remove], no restart button (recovery goes through disable→enable instead, which
    // hot-restarts the process server-side via `PluginSupervisor.restart`).

    func testStoppedTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "stopped", disabled: false)
        XCTAssertEqual(r.statusText, "Stopped")
        XCTAssertEqual(r.statusColorKind, .stopped)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testBackoffTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "backoff", disabled: false)
        XCTAssertEqual(r.statusText, "Backoff")
        XCTAssertEqual(r.statusColorKind, .backoff)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testCircuitOpenTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "circuit-open", disabled: false)
        XCTAssertEqual(r.statusText, "Circuit open")
        XCTAssertEqual(r.statusColorKind, .circuitOpen)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testStartingTier2EnabledGetsDisableRemoveNoRestart() {
        let r = row(tier: "platform", status: "starting", disabled: false)
        XCTAssertEqual(r.statusText, "Starting")
        XCTAssertEqual(r.statusColorKind, .starting)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testRestartIsNeverOfferedOutsideRunning() {
        for status in ["stopped", "backoff", "circuit-open", "starting", "na", nil] {
            let r = row(status: status, disabled: false)
            XCTAssertFalse(r.actions.contains(.restart), "status \(status ?? "nil") must not offer .restart")
        }
    }

    // MARK: - Action rule: DISABLED (any tier/status) → [.enable, .remove]

    func testDisabledTier2GetsEnableRemove() {
        let r = row(tier: "platform", status: "na", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
    }

    func testDisabledTier1GetsEnableRemove() {
        let r = row(tier: "capability", status: "na", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
    }

    /// `disabled` is checked BEFORE `status` — a stale/inconsistent "running" status on a disabled
    /// row (shouldn't happen server-side, but the mapping must still fail toward "Disabled", never
    /// toward offering a Restart on a plugin the user just turned off) still reads as disabled.
    func testDisabledTakesPriorityOverAnyReportedStatus() {
        let r = row(status: "running", disabled: true)
        XCTAssertEqual(r.statusText, "Disabled")
        XCTAssertEqual(r.statusColorKind, .disabled)
        XCTAssertEqual(r.actions, [.enable, .remove])
        XCTAssertFalse(r.actions.contains(.restart))
    }

    // MARK: - Action rule: na/Tier-1/legacy (enabled) → [.disable, .remove], NO running indicator

    func testTier1EnabledNaGetsDisableRemove() {
        let r = row(tier: "capability", status: "na", disabled: false)
        XCTAssertEqual(r.tierBadge, "Tier 1")
        XCTAssertEqual(r.statusText, "N/A")
        XCTAssertEqual(r.statusColorKind, .na)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testLegacyPluginGetsLegacyBadgeAndNaBehavior() {
        let r = row(tier: nil, legacy: true, status: nil, disabled: false)
        XCTAssertEqual(r.tierBadge, "Legacy")
        XCTAssertEqual(r.statusText, "N/A")
        XCTAssertEqual(r.statusColorKind, .na)
        XCTAssertEqual(r.actions, [.disable, .remove])
    }

    func testUnrecognizedTierNonLegacyGetsUnknownBadge() {
        let r = row(tier: nil, legacy: false)
        XCTAssertEqual(r.tierBadge, "Unknown")
    }

    // MARK: - `na` must render DISTINCTLY from every Tier-2 runtime state (and `disabled`)

    func testNaColorKindIsDistinctFromEveryOtherKind() {
        let others: Set<PluginStatusColorKind> = [.running, .starting, .stopped, .backoff, .circuitOpen, .disabled]
        XCTAssertFalse(others.contains(.na))
    }

    func testNaAndStoppedAreDifferentRenderStates() {
        let na = row(tier: "capability", status: "na", disabled: false)
        let stopped = row(tier: "platform", status: "stopped", disabled: false)
        XCTAssertNotEqual(na.statusColorKind, stopped.statusColorKind)
        XCTAssertNotEqual(na.statusText, stopped.statusText)
    }

    // MARK: - Consent text

    func testConsentTextNoConsentRequired() {
        let r = row(requiredConsents: [], consented: [])
        XCTAssertEqual(r.consentText, "No consent required")
    }

    func testConsentTextFullyConsented() {
        let r = row(requiredConsents: ["network"], consented: ["network"])
        XCTAssertEqual(r.consentText, "Consented: network")
    }

    func testConsentTextReportsOnlyMissingClasses() {
        let r = row(requiredConsents: ["network", "fs"], consented: ["network"])
        XCTAssertEqual(r.consentText, "Needs consent: fs")
    }

    // MARK: - Version

    func testVersionPassesThroughVerbatim() {
        XCTAssertEqual(row(version: "3.4.5").version, "3.4.5")
    }

    func testMissingVersionRendersEmDash() {
        XCTAssertEqual(row(version: nil).version, "—")
    }

    // MARK: - Identifiable

    func testRowIdIsThePluginName() {
        XCTAssertEqual(row(name: "sample-echo").id, "sample-echo")
    }
}
