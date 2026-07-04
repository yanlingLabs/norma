import AppKit

/// D6: haptics fire at EXACTLY three sites — these three functions are the only
/// NSHapticFeedbackManager callers in the app. Do not add more.
enum Haptics {
    static func gestureRecognized() {
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    }
    static func messageSent() {
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now)
    }
    static func approvalRequested() {
        NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
    }
}
