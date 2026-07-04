import Foundation

/// The orb's presentation states (spec §5 2b). `fieldOpen` arrives in 2c.
enum OrbStatus: Equatable {
    case idle
    case thinking
    case toolRunning(name: String)
    case approvalNeeded(count: Int)
    case disconnected

    /// Text for the orb's trailing pill; nil = no pill.
    var pillText: String? {
        switch self {
        case .idle: return nil
        case .thinking: return "thinking…"
        case .toolRunning(let name): return "⚙ \(name)"
        case .approvalNeeded(let n): return n == 1 ? "needs approval" : "needs approval (\(n))"
        case .disconnected: return "disconnected"
        }
    }
}

/// PURE composition for the "n/m working…" pill (spec change: while a turn is running AND
/// tasks exist, the pill names the task being worked instead of a bare "thinking…").
/// n = index of the task being worked (completed + 1, clamped to total); m = total.
func workingPillText(done: Int, total: Int) -> String {
    "☑ \(min(done + 1, total))/\(total) working…"
}
