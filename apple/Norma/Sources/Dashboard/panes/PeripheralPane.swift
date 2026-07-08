import ServiceManagement
import SwiftUI

/// "kind:id" — e.g. "session:s_1". Takes plain strings (not `SessionEvent.Holder` — that type has
/// no PUBLIC memberwise initializer, see `PeripheralProviderTests`' own doc comment on the same
/// constraint) so this stays trivially unit-testable without decoding a fixture.
func holderDisplay(kind: String, id: String) -> String {
    "\(kind):\(id)"
}

/// "expires in <elapsed>" / "expired" — derived purely from `expiresAt` (ms epoch) and `nowMs`.
/// `PeripheralLeaseInfo` carries no separate "granted at" timestamp (`PeripheralProvider.handle`
/// never captures `LeaseGranted.ts`), so remaining-time-to-expiry is this pane's "age" signal —
/// reuses `formatElapsed`, same as the Daemon-status pane's uptime.
func peripheralLeaseAgeText(expiresAt: Int, nowMs: Int) -> String {
    let remaining = expiresAt - nowMs
    guard remaining > 0 else { return "expired" }
    return "expires in \(formatElapsed(remaining))"
}

/// Task 5 (2f-ii): the Dashboard's Peripheral pane — spec §B: "active leases (class, holder, age)
/// + the panic button (same action as the menu item)". `provider` is injected directly (an
/// already-decoupled, published view-model — same posture as `SessionsPane`'s `SessionDirectory`,
/// not a `NormaClient`); the Panic button calls the SAME `PeripheralProvider.panic()` the menu
/// item and hotkey use (Task 4).
struct PeripheralPane: View {
    @ObservedObject var provider: PeripheralProvider
    /// Task 4 (4c): the helper-approval row below reads this directly — same `@ObservedObject`
    /// posture as `provider` above.
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Peripheral").font(.headline)
                Spacer()
                Button("Panic") { provider.panic() }
                    .foregroundStyle(.red)
                    .disabled(provider.activeLeases.isEmpty)
            }
            helperStatusRow
            Divider()
            if provider.activeLeases.isEmpty {
                Text("No active leases").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(provider.activeLeases) { lease in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(lease.class)
                                    .font(.system(size: 13, weight: .medium))
                                Text(holderDisplay(kind: lease.holder.kind, id: lease.holder.id))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                Text(peripheralLeaseAgeText(expiresAt: lease.expiresAt, nowMs: Int(Date().timeIntervalSince1970 * 1000)))
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Spacer()
        }
        .padding()
    }

    /// Task 4 (4c): "helper-status row — state text from the @Published status enum + 'Open System
    /// Settings' button" (brief). The button opens the SAME Login Items pane the user approves
    /// `NormaHelper` in — `SMAppService.openSystemSettingsLoginItems()` — shown only when
    /// `helperStatusDisplay` says there's something actionable there (`.requiresApproval`/
    /// `.unknown`; see that function's doc comment in `HelperClient.swift`).
    private var helperStatusRow: some View {
        let display = helperStatusDisplay(helperClient.status)
        return HStack {
            Text(display.stateText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Spacer()
            if display.showsOpenSettingsButton {
                Button("Open System Settings") {
                    SMAppService.openSystemSettingsLoginItems()
                }
                .font(.system(size: 12))
            }
        }
    }
}
