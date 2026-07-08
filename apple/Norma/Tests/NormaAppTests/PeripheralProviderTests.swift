import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 4 (2f): `shouldServe` (the pure decision core) + `PeripheralProvider`'s activeLeases
/// tracking / respond / panic behavior. Deliberately does NOT exercise hotkey registration,
/// screen-lock observation, or TCC polling — those are LIVE-GATE items (`registerPanicSurfaces()`/
/// `startTCCPolling()` are never called here), matching the brief's "Pure helpers unit-tested;
/// UI/registration paths noted for the live gate."
///
/// `SessionEvent`'s nested structs (`LeaseGranted`/`Holder`/etc.) have no PUBLIC memberwise
/// initializer (NormaProtocol relies on `Codable` synthesis only, matching every other test file
/// in this codebase — see `SessionFeedTests`/`AppModelTests`), so test events are built the SAME
/// way production code receives them: JSON-decoded, not struct-literal-constructed.
@MainActor
final class PeripheralProviderTests: XCTestCase {
    private func holder(kind: String = "session", id: String = "s_1") -> SessionEvent.Holder {
        try! JSONDecoder().decode(SessionEvent.Holder.self, from: Data(#"{"kind":"\#(kind)","id":"\#(id)"}"#.utf8))
    }

    private func sessionEvent(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    // Jan 1 2100 UTC in ms — genuinely far in the future (NOT `999_999_999_999`, which is only
    // ~2001: a real bug caught by running these tests, left as a comment so it isn't reintroduced).
    private static let farFutureMs = 4_102_444_800_000

    /// The default token every test's `callRequestedEvent()` uses ("tok_1") hashed — kept as a
    /// single source of truth so `leaseGrantedEvent()`'s default `tokenHash` and
    /// `callRequestedEvent()`'s default `token` stay a matching pair without hardcoding the hex
    /// digest twice. `sha256Hex` is the SAME function `shouldServe` uses in production
    /// (`@testable import Norma`), so this doubles as a light round-trip check of that helper.
    private static let defaultTokenHash = sha256Hex("tok_1")

    private func leaseGrantedEvent(leaseId: String = "lease_1", class cls: String = "noop", expiresAt: Int = PeripheralProviderTests.farFutureMs, tokenHash: String = PeripheralProviderTests.defaultTokenHash) -> SessionEvent {
        sessionEvent(#"{"type":"lease_granted","seq":1,"sessionId":"s_1","ts":0,"threadId":"main","leaseId":"\#(leaseId)","class":"\#(cls)","holder":{"kind":"session","id":"s_1"},"expiresAt":\#(expiresAt),"tokenHash":"\#(tokenHash)"}"#)
    }

    private func leaseLostEvent(leaseId: String = "lease_1", class cls: String = "noop", reason: String = "released") -> SessionEvent {
        sessionEvent(#"{"type":"lease_lost","seq":2,"sessionId":"s_1","ts":1,"threadId":"main","leaseId":"\#(leaseId)","class":"\#(cls)","holder":{"kind":"session","id":"s_1"},"reason":"\#(reason)"}"#)
    }

    private func callRequestedEvent(requestId: String = "req_1", leaseId: String = "lease_1", token: String = "tok_1", class cls: String = "noop", payloadJson: String = #"{"ping":1}"#) -> SessionEvent {
        sessionEvent(#"{"type":"peripheral_call_requested","seq":3,"sessionId":"s_1","ts":2,"threadId":"main","requestId":"\#(requestId)","leaseId":"\#(leaseId)","token":"\#(token)","class":"\#(cls)","payloadJson":\#(JSONEncodedString(payloadJson))}"#)
    }

    /// `payloadJson` is itself a STRING field on the wire (a JSON string containing JSON) —
    /// double-encode it so the outer literal is valid JSON.
    private func JSONEncodedString(_ s: String) -> String {
        let data = try! JSONEncoder().encode(s)
        return String(data: data, encoding: .utf8)!
    }

    private func makeProvider() -> PeripheralProvider {
        PeripheralProvider(client: NormaClient(makeTransport: { FeedScriptedTransport() }, token: "tok", clientName: "provider-test"))
    }

    private func connectedProvider() async throws -> (PeripheralProvider, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = NormaClient(makeTransport: { t }, token: "tok", clientName: "provider-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (PeripheralProvider(client: client), t)
    }

    // MARK: - Pure decision core: shouldServe

    func testShouldServeServesNoopWhenLeaseValid() {
        // Also exercises the "valid-token serve" path (spec §A1): the call's token hashes to
        // exactly the lease's tokenHash.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .serve)
    }

    func testShouldServeDeniesUnknownLease() {
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_ghost", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("lease_not_found"))
    }

    func testShouldServeDeniesTokenMismatchWithAGarbageToken() {
        // Spec §A1 defect fix: a garbage token with a VALID leaseId must be rejected, not served
        // — a right leaseId alone is not enough, per "no token, no service."
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_garbage_totally_wrong", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("token_mismatch"))
    }

    func testShouldServeDeniesEmptyToken() {
        // An empty token must not accidentally satisfy the hash comparison (sha256("") is itself
        // a valid-looking 64-char hex digest — this asserts it still doesn't match a real lease's
        // tokenHash).
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("token_mismatch"))
    }

    func testShouldServeDeniesClassMismatchAgainstTheGrantedLease() {
        // Granted for "noop"; the call claims a different class for the SAME leaseId. Token
        // matches the lease so this exercises class_mismatch specifically, not token_mismatch.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "screenshot", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("class_mismatch"))
    }

    func testShouldServeDeniesExpiredLeaseInclusiveBoundary() {
        // nowMs == expiresAt counts as expired (matches core's expiredLeases inclusive boundary).
        // Token matches so this exercises the expiry check specifically.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 500, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("expired"))
    }

    func testShouldServeDeniesUnsupportedClassEvenWithAValidLease() {
        // v1 only serves noop — a real, valid, unexpired, correctly-tokened lease for
        // "screenshot" is still denied.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "screenshot", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "screenshot", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("unsupported_class"))
    }

    // MARK: - handle(): activeLeases tracking (no network)

    func testHandleLeaseGrantedAddsToActiveLeases() async {
        let provider = makeProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.map(\.leaseId), ["lease_1"])
        XCTAssertEqual(provider.activeLeases.first?.class, "noop")
    }

    func testHandleLeaseGrantedIsIdempotentOnRedelivery() async {
        // Both broadcastTransient's session fan-out AND the provider-direct push can land the
        // SAME grant when this connection is also attached to the leasing session — must not
        // duplicate the entry (daemon.ts's emitTransient fix, see Task 4's core-side change).
        let provider = makeProvider()
        let granted = leaseGrantedEvent()
        await provider.handle(granted)
        await provider.handle(granted)
        XCTAssertEqual(provider.activeLeases.count, 1)
    }

    func testHandleLeaseLostRemovesFromActiveLeases() async {
        let provider = makeProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)
        await provider.handle(leaseLostEvent())
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    func testHandleLeaseLostForUnknownLeaseIsANoOp() async {
        let provider = makeProvider()
        await provider.handle(leaseLostEvent(leaseId: "lease_ghost"))
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    func testHandleIgnoresUnrelatedSessionEventTypes() async {
        let provider = makeProvider()
        await provider.handle(sessionEvent(#"{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}"#))
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    // MARK: - handle(peripheral_call_requested) → peripheral.respond over the wire

    /// `NormaClient`'s `request()` blocks until a matching `id` response arrives (or a 5s
    /// timeout) — feed one immediately after asserting on the outbound bytes so these tests don't
    /// eat the full timeout, mirroring NormaKitTests' `MethodWrapperTests.roundTrip` pattern.
    private func ackLastSent(_ t: FeedScriptedTransport, index: Int) {
        let req = feedLineJSON(t.sent[index])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
    }

    func testPeripheralCallRequestedServesNoopWithEcho() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())

        async let handled: Void = provider.handle(callRequestedEvent())

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "peripheral.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["requestId"] as? String, "req_1")
        XCTAssertNil(params?["error"])
        let resultJson = params?["resultJson"] as? String
        XCTAssertNotNil(resultJson, "expected a resultJson for a served noop call")
        let echoed = feedLineJSON(resultJson!)
        XCTAssertEqual((echoed["echo"] as? [String: Any])?["ping"] as? Int, 1)

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesWhenNoMatchingLocalLease() async throws {
        let (provider, t) = try await connectedProvider()
        // No lease_granted ever delivered — the local activeLeases set is empty.
        async let handled: Void = provider.handle(callRequestedEvent())

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "peripheral.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "lease_not_found")
        XCTAssertNil(params?["resultJson"])

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesTokenMismatchOverTheWire() async throws {
        // End-to-end version of testShouldServeDeniesTokenMismatchWithAGarbageToken: a real
        // lease_granted lands (tokenHash for "tok_1"), then a peripheral_call_requested carries a
        // DIFFERENT token for the same, otherwise-valid leaseId — must be denied, not served.
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())

        async let handled: Void = provider.handle(callRequestedEvent(token: "tok_wrong_guess"))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "token_mismatch")
        XCTAssertNil(params?["resultJson"])

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesUnsupportedClass() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent(class: "screenshot"))

        async let handled: Void = provider.handle(callRequestedEvent(class: "screenshot"))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "unsupported_class")

        ackLastSent(t, index: 1)
        await handled
    }

    // MARK: - panic()

    func testPanicClearsActiveLeasesSynchronouslyAndRevokesAllOverTheWire() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)

        provider.panic()
        XCTAssertTrue(provider.activeLeases.isEmpty, "panic() must clear the local set synchronously, not wait on the network round trip")

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake; the
        // leaseGranted-tracking handle() above never touches the wire either. panic()'s revoke
        // RPC runs on its own unstructured Task (not awaited by panic() itself) — ack it so it
        // doesn't linger past this test on a 5s timeout.
        await feedWaitUntil { t.sent.count >= 2 }
        let revoke = feedLineJSON(t.sent[1])
        XCTAssertEqual(revoke["method"] as? String, "peripheral.revoke")
        let params = revoke["params"] as? [String: Any]
        XCTAssertEqual(params?["all"] as? Bool, true)
        XCTAssertEqual(params?["reason"] as? String, "panic")
        ackLastSent(t, index: 1)
    }

    // MARK: - currentClasses() / advertiseIfConnected()

    func testCurrentClassesAlwaysIncludesAllFourWithNoopGranted() {
        let classes = PeripheralProvider.currentClasses()
        XCTAssertEqual(Set(classes.map(\.class)), Set(["noop", "screenshot", "ax-read", "input-drive"]))
        XCTAssertEqual(classes.first(where: { $0.class == "noop" })?.tccGranted, true)
    }

    func testAdvertiseIfConnectedSendsAllFourClasses() async throws {
        let (provider, t) = try await connectedProvider()
        async let handled: Void = provider.advertiseIfConnected()
        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        let advertise = feedLineJSON(t.sent[1])
        XCTAssertEqual(advertise["method"] as? String, "peripheral.advertise")
        let classes = (advertise["params"] as? [String: Any])?["classes"] as? [[String: Any]]
        XCTAssertEqual(classes?.count, 4)
        ackLastSent(t, index: 1)
        await handled
    }

    /// FINAL-REVIEW FIX (M1): `advertiseIfConnected()` is the exact closure `AppDelegate` wires to
    /// `AppModel.onClientConnected` — fired on the app's initial connect AND (since this fix) on
    /// every subsequent reconnect. On a daemon restart/socket drop, core's `PeripheralBroker` state
    /// dies with it; without clearing here first, the app would keep ghost `activeLeases` from the
    /// dead connection. `activeLeases.isEmpty` is exactly the signal both panic surfaces key off —
    /// `AppDelegate`'s `peripheral.$activeLeases` subscription mounts/unmounts the red menu item on
    /// it, and `updatePanicRegistration()` (called synchronously here) does the same for the Carbon
    /// hotkey — so asserting it's empty IS asserting both panic surfaces are unmounted.
    func testAdvertiseIfConnectedClearsGhostLeasesBeforeReadvertising() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)

        // Simulates the reconnect callback: AppModel.onClientConnected fires this SAME method
        // again after a reconnect (see AppModel.handle's `.connection(.connected)` case).
        async let handled: Void = provider.advertiseIfConnected()

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        // Cleared BEFORE the advertise round-trip resolves — the clear is synchronous, at the top
        // of advertiseIfConnected(), strictly ahead of the (async) network call.
        XCTAssertTrue(provider.activeLeases.isEmpty, "reconnect must clear ghost leases from a dead broker's state, not just leave them until the next lease_lost")

        let advertise = feedLineJSON(t.sent[1])
        XCTAssertEqual(advertise["method"] as? String, "peripheral.advertise")
        ackLastSent(t, index: 1)
        await handled

        // Still empty after the round-trip completes — the fresh advertise doesn't resurrect them.
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }
}
