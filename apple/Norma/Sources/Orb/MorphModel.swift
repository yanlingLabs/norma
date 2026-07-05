import Foundation

/// v1's morph spring state (GlassFieldWindow.swift:1795-1845), published so every view tied
/// to the orb↔field morph — the orb circle, the composer shell, the field's auxiliary chrome —
/// renders off the SAME continuous 0…1 value every frame. No `withAnimation` anywhere: the
/// 60Hz morph timer (owned by `OrbWindowController`) IS the animation.
@MainActor
final class MorphModel: ObservableObject {
    @Published var progress: Double = 0
}
