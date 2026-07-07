/// Shared pure subagent-display logic (Phase 2e-ii) — glyph/label/alive are LOCKSTEP with
/// `packages/cli/src/subagent-display.ts` (same fixtures both sides, like TaskDisplay.swift).
/// `subagentActiveMs` is SWIFT-ONLY: the active timer renders only in the window (the CLI shows
/// token arrows instead — its TS-only twin is `subagentTokens`). Pure — no SwiftUI, no clocks.

func subagentGlyph(_ status: String) -> String {
    if status == "working" { return "●" }
    if status == "done" { return "✓" }
    return "◌" // queued, or any unrecognized status
}

/// description (trimmed) if non-empty, else the prompt's FIRST line capped at 40 chars with a
/// trailing "…" (39 kept + ellipsis; exactly 40 fits untruncated).
func subagentLabel(description: String?, prompt: String) -> String {
    let desc = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !desc.isEmpty { return desc }
    let firstLine = prompt.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return firstLine.count > 40 ? String(firstLine.prefix(39)) + "…" : firstLine
}

func anySubagentAlive(_ statuses: [String]) -> Bool {
    statuses.contains { $0 != "done" }
}

/// Banked active spans + the open span (only while working). `activeSince`/`nowMs` are ms since
/// epoch — `nowMs` is the VIEW's clock (TimelineView tick), the stored fields are daemon `event.ts`
/// values; max(0, …) guards clock skew so a fresh span never renders negative.
func subagentActiveMs(activeMs: Int, activeSince: Int?, status: String, nowMs: Int) -> Int {
    guard status == "working", let since = activeSince else { return max(0, activeMs) }
    return max(0, activeMs) + max(0, nowMs - since)
}
