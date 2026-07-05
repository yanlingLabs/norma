import AppKit

/// D6: haptics fire at EXACTLY three sites — these three functions route through
/// TrackpadSwipeHaptics (which uses a private trackpad actuator via MultitouchSupport.framework,
/// falling back to NSHapticFeedbackManager when unavailable). This fixes gate-1 root cause:
/// macOS suppresses NSHapticFeedbackManager outside drag contexts.
enum Haptics {
    static func gestureRecognized() {
        TrackpadSwipeHaptics.performAcceptedSwipe()
    }
    static func messageSent() {
        TrackpadSwipeHaptics.perform(.generic, performanceTime: .now)
    }
    static func approvalRequested() {
        TrackpadSwipeHaptics.perform(.levelChange, performanceTime: .now)
    }
}
