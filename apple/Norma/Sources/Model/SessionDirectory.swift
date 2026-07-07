import Foundation
import NormaProtocol

/// 2e-iii Task 5: a live list of every session (title/createdAt/scope/cwd), backing the left
/// sidebar's session switcher (`SessionSidebar` — not yet mounted anywhere, Task 6 does that).
/// Deliberately socket-free: production wiring (`AppModel`/`DetachedWindowController`, both own
/// their own `NormaClient`) injects a `lister` closure around `client.listSessions()`, the same
/// dependency-injection shape `SessionFeed` uses for its transport — this file stays testable with
/// a stub closure, no scripted transport needed (see `SessionDirectoryTests`).
@MainActor
final class SessionDirectory: ObservableObject {
    @Published private(set) var rows: [SessionSummary] = []

    private let lister: () async throws -> [SessionSummary]

    init(lister: @escaping () async throws -> [SessionSummary]) {
        self.lister = lister
    }

    /// Full re-list, newest-first. Defensive: a thrown/failed `lister` call (daemon hiccup, RPC
    /// timeout) leaves `rows` exactly as they were — a transient failure must never blank the
    /// sidebar out from under the user.
    func refresh() async {
        guard let fetched = try? await lister() else { return }
        rows = fetched.sorted { $0.createdAt > $1.createdAt }
    }

    /// FINAL-REVIEW FIX (M1): the wirers' (`AppModel.init` / `DetachedWindowController.init`) own
    /// bootstrap kick, named so it's a single testable seam instead of an inline
    /// `Task { await refresh() }` duplicated at both construction sites. Fire-and-forget, same
    /// posture as `handle`'s event-triggered refreshes below: without SOME initial load, a cold
    /// window's session switcher (and `WorkSidebar`'s info block, which reads this same `directory`
    /// instance) stays empty until an unrelated session_created/session_titled broadcast happens to
    /// arrive — spec demands "session.list on appear + refresh on events", not "…or whenever the
    /// next broadcast happens to land." A failure here (e.g. this directory's own harness hasn't
    /// finished `client.connect()` yet at construction time) is silently absorbed by `refresh()`'s
    /// own `try?`; `SessionSidebar`'s own `.task { await directory.refresh() }` and every
    /// session-lifecycle broadcast are the belt-and-suspenders that keep retrying.
    func startInitialLoad() {
        Task { await refresh() }
    }

    /// Session-lifecycle events broadcast to every authed harness (`session_created`,
    /// `session_titled` — see the daemon's fan-out, spec'd in Task 1/2/3 of this phase). Both kick
    /// a full `refresh()` so the row list itself (new row appearing; sort order) stays correct; a
    /// titled event ADDITIONALLY patches the affected row's title in place, synchronously, so the
    /// sidebar's title updates the instant the event arrives rather than waiting on the refresh
    /// round trip (which the caller's own socket may be mid-backoff on).
    func handle(_ event: SessionEvent) {
        switch event {
        case .sessionTitled(let v):
            if let idx = rows.firstIndex(where: { $0.sessionId == v.sessionId }) {
                rows[idx].title = v.title
            }
            Task { await refresh() }
        case .sessionCreated:
            Task { await refresh() }
        default:
            break // every other event type is irrelevant to the session list itself
        }
    }
}

/// One row of the directory. `id` mirrors `sessionId` (`Identifiable` for `ForEach` in
/// `SessionSidebar`) rather than being a separate synthesized value — two rows for the same
/// session id are never a legitimate state.
struct SessionSummary: Equatable, Identifiable {
    let sessionId: String
    var title: String?
    var createdAt: Int
    var scope: String
    var cwd: String?
    var id: String { sessionId }
}
