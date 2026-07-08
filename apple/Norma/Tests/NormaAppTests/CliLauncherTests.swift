import XCTest
@testable import Norma

/// 2e-iv Task 1: the CLI launcher's pure/deterministic parts — script content, install-path
/// decision, ensureWrapper idempotence. The actual `open -a Terminal` launch is an
/// end-of-2e live-gate item.
@MainActor
final class CliLauncherTests: XCTestCase {
    func testWrapperScriptContent() {
        XCTAssertEqual(
            CliLauncher.wrapperScript(repoRoot: "/Users/x/Norma v2"),
            "#!/bin/sh\nexec /usr/bin/env bun \"/Users/x/Norma v2/packages/cli/src/main.ts\" \"$@\"\n"
        )
    }

    func testInstallPathFallsBackToLocalBin() throws {
        // A temp HOME with no /opt/homebrew override isn't simulable for the homebrew branch on
        // this machine (it exists and is writable) — so pin BOTH branches via the decision inputs:
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        // fallback branch: point `home` at tmp and use a FileManager where /opt/homebrew/bin is
        // "absent" — simulate by asserting the pure suffix logic instead:
        let fallback = CliLauncher.wrapperInstallPath(fileManager: AbsentBrewFileManager(), home: tmp)
        XCTAssertEqual(fallback.path, tmp.appendingPathComponent(".local/bin/norma").path)
    }

    func testEnsureWrapperWritesOnceAndRewritesOnDrift() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        let launcher = CliLauncher(installPathOverride: tmp.appendingPathComponent("bin/norma"))
        launcher.repoRoot = "/repo/a"
        let p1 = try launcher.ensureWrapper()
        let bytes1 = try Data(contentsOf: p1)
        let mtime1 = try FileManager.default.attributesOfItem(atPath: p1.path)[.modificationDate] as! Date
        // idempotent: second call, same content → file not rewritten
        _ = try launcher.ensureWrapper()
        let mtime2 = try FileManager.default.attributesOfItem(atPath: p1.path)[.modificationDate] as! Date
        XCTAssertEqual(mtime1, mtime2)
        // drift (repo moved) → rewritten with new content
        launcher.repoRoot = "/repo/b"
        _ = try launcher.ensureWrapper()
        let bytes2 = try Data(contentsOf: p1)
        XCTAssertNotEqual(bytes1, bytes2)
        // executable bit set
        let perms = try FileManager.default.attributesOfItem(atPath: p1.path)[.posixPermissions] as! NSNumber
        XCTAssertEqual(perms.intValue & 0o111, 0o111)
    }
}

/// Test stub: reports /opt/homebrew/bin absent so wrapperInstallPath takes the fallback branch.
final class AbsentBrewFileManager: FileManager {
    override func fileExists(atPath path: String, isDirectory: UnsafeMutablePointer<ObjCBool>?) -> Bool {
        if path.hasPrefix("/opt/homebrew") { return false }
        return super.fileExists(atPath: path, isDirectory: isDirectory)
    }
}
