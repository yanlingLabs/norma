import SwiftUI

/// Spec §3: autoscroll only follows when the user is already near the bottom — v1 yanked
/// unconditionally on every streaming chunk (donor ChatRootView.swift:514-522); this is the
/// one deliberate improvement over the transplant.
func shouldAutoscroll(nearBottom: Bool, contentGrew: Bool) -> Bool {
    nearBottom && contentGrew
}

struct TranscriptView: View {
    @ObservedObject var adapter: FieldStateAdapter
    let tint: Color
    @State private var nearBottom = true
    @State private var showLatestPill = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(adapter.transcript.enumerated()), id: \.offset) { index, exchange in
                        exchangeRows(exchange, isLast: index == adapter.transcript.count - 1)
                            .id(index)
                    }
                }
                .padding(.vertical, 4)
            }
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 40
            } action: { _, isNear in
                nearBottom = isNear
                if isNear { showLatestPill = false }
            }
            // Task-4 review fix: onChange fires on ANY change — including the count DROPPING to
            // zero on session refocus (SessionModel.reset() swaps exchanges wholesale). Only a
            // genuine growth may follow/raise the pill; a reset must do neither.
            .onChange(of: adapter.transcript.count) { old, new in
                if new > old { follow(proxy) }
            }
            .onChange(of: adapter.liveStreamingText) { old, new in
                if (new?.count ?? 0) > (old?.count ?? 0) { follow(proxy) }
            }
            .overlay(alignment: .bottomTrailing) {
                if showLatestPill { latestPill(proxy) }
            }
        }
    }

    /// Extracted from `body` (Task-4 review, minor): the chained ScrollViewReader expression sat
    /// at SourceKit's type-check complexity cliff — keep `body` shallow so future edits don't
    /// tip it over.
    private func latestPill(_ proxy: ScrollViewProxy) -> some View {
        Button {
            scrollToBottom(proxy)
        } label: {
            Label("latest", systemImage: "arrow.down")
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(.thinMaterial))
        }
        .buttonStyle(.plain)
        .padding(8)
    }

    @ViewBuilder
    private func exchangeRows(_ exchange: Exchange, isLast: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !exchange.prompt.isEmpty {
                TranscriptUserBubble(text: exchange.prompt, tint: tint)
            }
            ForEach(Array(exchange.activity.enumerated()), id: \.offset) { _, item in
                TranscriptActivityRow(item: item)
            }
            // v1's synthetic-trailing-stream mechanism: while streaming, the LAST exchange
            // renders the growing partial as its reply.
            if isLast, let streaming = adapter.liveStreamingText {
                TranscriptAssistantMessage(text: streaming, isStreaming: true)
            } else if !exchange.reply.isEmpty {
                TranscriptAssistantMessage(text: exchange.reply, isStreaming: false)
            }
            if exchange.aborted { TranscriptStoppedRow() }
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        if shouldAutoscroll(nearBottom: nearBottom, contentGrew: true) {
            scrollToBottom(proxy)
        } else {
            showLatestPill = true
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        let last = adapter.transcript.count - 1
        guard last >= 0 else { return }
        withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last, anchor: .bottom) }
    }
}
