import Foundation
import IOKit

// MARK: - chargeLimitPlan (THE testable core)

/// What `HelperService.setChargeLimit` should do for a given requested percent, on a given chip
/// family. This is the SINGLE source of truth for the charge-limit decision table — everything
/// else (range validation, which SMC key to hit, what value to write) flows from this pure
/// function. `HelperService`/`SMCController` only ever *execute* a `ChargeLimitPlan`; they never
/// re-derive or duplicate this decision.
enum ChargeLimitPlan: Equatable {
    /// Apple Silicon: write the CHWA (charge-hold-when-away, "80% limit") key.
    case writeCHWA(Bool)
    /// Intel: write the BCLM (battery-charge-level-max) key to an explicit percent.
    case writeBCLM(UInt8)
    /// Apple Silicon only supports 80 or 100; anything strictly between is not representable.
    case unsupportedValue
    /// Outside the valid 50...100 range, on either chip family.
    case invalidRange
}

/// Pure decision table — no IOKit, no state, no side effects. Table (from task-3-brief.md):
///   Apple Silicon: 50-80 -> writeCHWA(true); 100 -> writeCHWA(false); 81-99 -> unsupportedValue
///   Intel:         50-100 -> writeBCLM(percent)
///   Anywhere:      <50 or >100 -> invalidRange (checked FIRST, before any chip-specific branch)
func chargeLimitPlan(percent: Int, appleSilicon: Bool) -> ChargeLimitPlan {
    guard percent >= 50 && percent <= 100 else { return .invalidRange }

    if appleSilicon {
        switch percent {
        case 50...80:
            return .writeCHWA(true)
        case 100:
            return .writeCHWA(false)
        default: // 81...99
            return .unsupportedValue
        }
    } else {
        return .writeBCLM(UInt8(percent))
    }
}

// MARK: - SMCController

/// Thin, deliberately-untested bridge to the AppleSMC IOKit user client. Struct layout mirrors the
/// long-reverse-engineered AppleSMC "YPCEvent" struct used by widely-deployed open-source SMC
/// tools (smcFanControl, SMCKit, smc-command, etc.) — AppleSMC.kext's user-client interface is
/// private and undocumented, so this cannot be meaningfully unit tested in this environment. Live
/// verification against real hardware is Task 6's gate (per task-3-brief.md); keep this class thin
/// and isolated so the untestable IOKit surface stays small and the pure `chargeLimitPlan` above
/// carries all the actual decision logic.
final class SMCController {

    enum SMCError: Error, Equatable {
        case serviceNotFound
        case openFailed(kern_return_t)
        case callFailed(kern_return_t)
        case keyNotFound(String)
    }

    private var connection: io_connect_t = 0

    // MARK: Public API

    /// `sysctlbyname("hw.optional.arm64", ...)` — present and 1 on Apple Silicon, absent (or 0)
    /// on Intel. This is the one piece of "real I/O" in this class that IS safe to exercise
    /// anywhere (no hardware/entitlement dependency), but it isn't table-tested since it isn't
    /// parameterized — `chargeLimitPlan` above is what's exhaustively tested.
    func isAppleSilicon() -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let rc = sysctlbyname("hw.optional.arm64", &value, &size, nil, 0)
        return rc == 0 && value == 1
    }

    func writeCHWA(_ on: Bool) throws {
        try withConnection { try self.write(key: "CHWA", bytes: [on ? 1 : 0]) }
    }

    func writeBCLM(_ percent: UInt8) throws {
        try withConnection { try self.write(key: "BCLM", bytes: [percent]) }
    }

    func readCHWA() throws -> Bool {
        try withConnection { (try self.read(key: "CHWA")).first ?? 0 != 0 }
    }

    func readBCLM() throws -> UInt8 {
        try withConnection { (try self.read(key: "BCLM")).first ?? 100 }
    }

    // MARK: Connection lifecycle

    private func withConnection<T>(_ body: () throws -> T) throws -> T {
        try open()
        defer { close() }
        return try body()
    }

    private func open() throws {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != 0 else { throw SMCError.serviceNotFound }
        defer { IOObjectRelease(service) }
        let rc = IOServiceOpen(service, mach_task_self_, 0, &connection)
        guard rc == kIOReturnSuccess else { throw SMCError.openFailed(rc) }
    }

    private func close() {
        guard connection != 0 else { return }
        IOServiceClose(connection)
        connection = 0
    }

    // MARK: SMC struct call plumbing

    /// IOConnectCallStructMethod selector for AppleSMC's "handle YPC event" method — the single
    /// entry point used for key info lookups, reads, and writes (which sub-operation is requested
    /// is encoded in the input struct's `data8` field, not the selector).
    private static let ypcEventSelector: UInt32 = 2
    private static let readKeySelector: UInt8 = 5
    private static let writeKeySelector: UInt8 = 6
    private static let getKeyInfoSelector: UInt8 = 9
    private static let successStatus: UInt8 = 0

    private func read(key: String) throws -> [UInt8] {
        let info = try keyInfo(for: key)

        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = Self.readKeySelector
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }

        return Self.unpack(output.bytes, count: Int(info.dataSize))
    }

    private func write(key: String, bytes: [UInt8]) throws {
        let info = try keyInfo(for: key)

        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = Self.writeKeySelector
        input.bytes = Self.pack(bytes)
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }
    }

    private func keyInfo(for key: String) throws -> SMCKeyInfoData {
        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.data8 = Self.getKeyInfoSelector
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }
        return output.keyInfo
    }

    private func call(_ input: SMCParamStruct) throws -> SMCParamStruct {
        var input = input
        var output = SMCParamStruct()
        var outputSize = MemoryLayout<SMCParamStruct>.size
        let rc = withUnsafeMutablePointer(to: &output) { outPtr -> kern_return_t in
            withUnsafePointer(to: &input) { inPtr in
                IOConnectCallStructMethod(
                    connection,
                    Self.ypcEventSelector,
                    inPtr,
                    MemoryLayout<SMCParamStruct>.size,
                    outPtr,
                    &outputSize
                )
            }
        }
        guard rc == kIOReturnSuccess else { throw SMCError.callFailed(rc) }
        return output
    }

    private static func fourCC(_ key: String) -> UInt32 {
        key.utf8.reduce(UInt32(0)) { ($0 << 8) + UInt32($1) }
    }

    private static func pack(_ values: [UInt8]) -> SMCBytes {
        var tuple = smcZeroBytes()
        withUnsafeMutableBytes(of: &tuple) { raw in
            for (index, value) in values.enumerated() where index < raw.count {
                raw[index] = value
            }
        }
        return tuple
    }

    private static func unpack(_ tuple: SMCBytes, count: Int) -> [UInt8] {
        withUnsafeBytes(of: tuple) { raw in
            Array(raw.prefix(max(0, count)))
        }
    }
}

// MARK: - SMC wire structs

/// AppleSMC's private "YPCEvent" struct, reverse-engineered by (and shared across) the open-source
/// SMC tooling ecosystem. Field order matters (it's read/written across the IOKit user client
/// boundary as raw bytes) — do not reorder without re-verifying against real hardware.
private struct SMCVersion {
    var major: UInt8 = 0
    var minor: UInt8 = 0
    var build: UInt8 = 0
    var reserved: UInt8 = 0
    var release: UInt16 = 0
}

private struct SMCPLimitData {
    var version: UInt16 = 0
    var length: UInt16 = 0
    var cpuPLimit: UInt32 = 0
    var gpuPLimit: UInt32 = 0
    var memPLimit: UInt32 = 0
}

private struct SMCKeyInfoData {
    // The real AppleSMC struct declares this as `IOByteCount`, which resolves to `UInt64` on
    // today's 64-bit-only macOS SDKs (confirmed against IOTypes.h) — using `UInt32` here would
    // silently desync this struct's layout from what AppleSMC.kext actually expects.
    var dataSize: UInt64 = 0
    var dataType: UInt32 = 0
    var dataAttributes: UInt8 = 0
}

private typealias SMCBytes = (
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
)

private func smcZeroBytes() -> SMCBytes {
    (0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0)
}

private struct SMCParamStruct {
    var key: UInt32 = 0
    var vers = SMCVersion()
    var pLimitData = SMCPLimitData()
    var keyInfo = SMCKeyInfoData()
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: SMCBytes = smcZeroBytes()
}
