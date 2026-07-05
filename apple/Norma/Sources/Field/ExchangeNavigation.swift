import Foundation

/// 2c wave 2 task 4: which way a 2-finger accepted swipe moves through exchange history.
/// `.older` is v1's `.previousTrack`-shaped direction (MusicDynamicIslandPlugin/MediaDynamic
/// IslandPlugin's `.left → previousTrack()`); `.newer` is `.right → nextTrack()`'s shape.
enum ExchangeNavDirection {
    case older
    case newer
}

/// Pure index arithmetic for exchange-history navigation — no dependency on `SessionModel` or
/// `OrbWindowController`, table-tested in isolation (`ExchangeNavigationTests`).
///
/// `nil` index means "live/draft view" — the newest position past all history (mirrors
/// `FieldView`'s existing `exchanges.last` / live-streaming display: no historical exchange is
/// pinned). `.older` from `nil` jumps to the last historical index (`count - 1`); `.older` from
/// an index clamps at `0` (can't go past the oldest exchange). `.newer` from `nil` stays `nil`
/// (already at the newest position); `.newer` from an index either advances or, once past the
/// last historical index, lands back on `nil` (returns to live) rather than wrapping or clamping.
func navigateExchange(_ index: Int?, direction: ExchangeNavDirection, count: Int) -> Int? {
    guard count > 0 else { return nil }
    switch direction {
    case .older:
        switch index {
        case nil: return count - 1
        case let i?: return max(0, i - 1)
        }
    case .newer:
        switch index {
        case nil: return nil
        case let i?: return i + 1 >= count ? nil : i + 1
        }
    }
}
