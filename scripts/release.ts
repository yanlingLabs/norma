/**
 * Norma release pipeline (release-pipeline T2, core). Chains:
 *   preflight -> [version bump] -> build (Developer ID + hardened runtime, T1's canonical
 *   override invocation) -> verify nested signatures -> zip -> notarize -> staple -> re-zip
 *   the stapled app -> spctl/stapler gates -> --dry-run stops here (T3 continues past this
 *   boundary with DMG + appcast + publish).
 *
 * Usage: bun run scripts/release.ts --dry-run [--beta] [--no-bump]
 *
 * `--beta` is accepted here (parsed, threaded through) but not yet consumed — the only thing
 * that reads it is `appcastItem`'s channel element, which T3 wires in. `--dry-run` NEVER
 * publishes (no gh, no appcast writes, no tags) and downgrades the production-Sparkle-key and
 * gh-auth preflight checks to warnings; every other check (identity, notary profile, clean
 * tree, tag collision) still hard-fails regardless of --dry-run.
 *
 * T1 findings this script carries (see .superpowers/sdd/task-11-report.md):
 *  - CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO is REQUIRED — without it Xcode injects
 *    get-task-allow=true and notarization silently auto-rejects.
 *  - The "Embed norma-core" postCompileScript now signs with --options runtime --timestamp
 *    (apple/Norma/project.yml, committed) so the nested binary carries hardened runtime too.
 *  - NormaHelper's embedded codesign identifier becomes "NormaHelper" (not "com.norma.helper")
 *    under this override set — confirmed harmless (Label-based launchd matching, team-based
 *    peer trust) — not fixed here, out of scope.
 *
 * T2 finding (this task, empirical — only surfaces on a REAL notarization submission, which is
 * why T1's audit couldn't have caught it): Sparkle.framework's own bundle gets correctly
 * re-signed by Xcode's "Embed Frameworks" copy-and-sign step (TeamIdentifier=37N77U9RSZ, per
 * T1), but that step does not recurse into the framework's OWN nested code. Sparkle's SPM
 * binary distribution ships Autoupdate, Updater.app, and the two XPCServices helpers ad-hoc
 * signed (flags=0x10002(adhoc,runtime), TeamIdentifier=not set, no secure timestamp) — the
 * first real `notarytool submit` rejected the build on exactly these four paths ("not signed
 * with a valid Developer ID certificate" + "signature does not include a secure timestamp").
 * Fixed below by re-signing each nested helper ourselves (deepest-first — codesign requires
 * inside-out signing since signing a container after its contents change invalidates the
 * container's own seal), preserving each one's existing entitlements as-is (extracted then
 * reapplied; Autoupdate is the only one with a real entitlement — see resignPreserving below),
 * then re-signing Sparkle.framework and finally the outer Norma.app so their seals pick up the
 * changed nested content.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readCanonical } from "./version-lib";
import { preflight } from "./release-lib";

const TEAM_ID = "37N77U9RSZ";
const NOTARY_PROFILE = "norma-notary";
const APPLE_DIR = join(ROOT, "apple", "Norma");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const BETA = argv.includes("--beta");
const NO_BUMP = argv.includes("--no-bump");

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

// Throwing shell helper for steps that should abort the whole run on any nonzero exit —
// mirrors scripts/sparkle-feed-gate.ts's `sh` idiom.
const sh = (cmd: string, cwd = ROOT): string =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });

// Non-throwing probe — used ONLY by preflight checks, which must run to completion and
// aggregate every failure rather than aborting on the first shell error.
function probe(cmd: string, cwd = ROOT): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// ---------------------------------------------------------------------------
// 1. Preflight — abort listing ALL failures at once, never just the first one hit.
// ---------------------------------------------------------------------------
const preVersion = readCanonical();
const pre = preflight({
  checks: {
    identity: () => {
      const out = probe(`security find-identity -v -p codesigning`).stdout;
      if (out.includes("Developer ID Application") && out.includes(TEAM_ID)) return null;
      return `missing Developer ID identity for team ${TEAM_ID} — create it in Xcode > Settings > Accounts > Manage Certificates`;
    },
    notary: () => {
      // `notarytool history` exits 0 for both "No submission history." and a populated list;
      // it exits nonzero (observed: 69) on an invalid/missing keychain profile.
      const r = probe(`xcrun notarytool history --keychain-profile ${NOTARY_PROFILE}`);
      if (r.ok) return null;
      return `notary profile '${NOTARY_PROFILE}' missing/invalid — run: xcrun notarytool store-credentials ${NOTARY_PROFILE} --apple-id <email> --team-id ${TEAM_ID}`;
    },
    prodKey: () => {
      const r = probe(`security find-generic-password -s "https://sparkle-project.org"`);
      if (r.ok) return null;
      const line = `production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)`;
      if (DRY_RUN) {
        console.warn(
          `WARNING: ${line}\n  (dry-run: downgraded to a warning — a real release still needs it before T3's appcast-signing step)`,
        );
        return null;
      }
      return line;
    },
    gh: () => {
      const r = probe(`gh auth status`);
      if (r.ok) return null;
      const line = `gh not authenticated — run: gh auth login`;
      if (DRY_RUN) {
        console.warn(`WARNING: ${line}`);
        return null;
      }
      return line;
    },
    tree: () => {
      const out = probe(`git status --porcelain`).stdout.trim();
      return out === "" ? null : `working tree not clean — commit or stash changes before releasing`;
    },
    tag: () => {
      const out = probe(`git tag -l v${preVersion}`).stdout.trim();
      return out === "" ? null : `tag v${preVersion} already exists — bump the version or delete the stale tag`;
    },
  },
});

if (!pre.ok) {
  console.error("Preflight failed:");
  for (const line of pre.failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("Preflight: OK");

// ---------------------------------------------------------------------------
// 2. Version bump (unless --no-bump).
// ---------------------------------------------------------------------------
if (!NO_BUMP) {
  console.log("Bumping version...");
  console.log(sh(`bun run version:bump`).trim());
} else {
  console.log(`--no-bump: staying on ${preVersion}`);
}
const version = readCanonical();
console.log(`Releasing version ${version}${BETA ? " (beta)" : ""}`);

// ---------------------------------------------------------------------------
// 3. Build — T1's canonical override invocation, -derivedDataPath out/release/<v>/dd.
// ---------------------------------------------------------------------------
const OUT = join(ROOT, "out", "release", version);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dd = join(OUT, "dd");

console.log("Generating Xcode project (xcodegen)...");
sh(`xcodegen generate`, APPLE_DIR);

console.log("Building Release (Developer ID, org team 37N77U9RSZ, hardened runtime)...");
sh(
  `xcodebuild -project Norma.xcodeproj -scheme Norma -destination 'platform=macOS' -configuration Release ` +
    `DEVELOPMENT_TEAM=${TEAM_ID} CODE_SIGN_IDENTITY="Developer ID Application" CODE_SIGN_STYLE=Manual ` +
    `OTHER_CODE_SIGN_FLAGS="--timestamp" ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO ` +
    `-derivedDataPath "${dd}" build`,
  APPLE_DIR,
);
const app = join(dd, "Build", "Products", "Release", "Norma.app");
if (!existsSync(app)) fail(`build did not produce ${app}`);
console.log(`Built: ${app}`);

// ---------------------------------------------------------------------------
// 3b. Re-sign Sparkle.framework's nested helper binaries (T2 finding, see header comment) —
//     the SPM binary distribution ships them ad-hoc, which Apple's notary service rejects.
//     Preserves each target's existing entitlements as-is (extract, then reapply).
// ---------------------------------------------------------------------------
const IDENTITY = "Developer ID Application";
function resignPreservingEntitlements(path: string) {
  const entPlist = join(OUT, `.ent-${path.replace(/[^a-zA-Z0-9]/g, "_")}.plist`);
  rmSync(entPlist, { force: true });
  probe(`codesign -d --entitlements ":${entPlist}" "${path}"`); // best-effort; not every target has one
  const entFlag = existsSync(entPlist) ? `--entitlements "${entPlist}"` : "";
  sh(`codesign --force --options runtime --timestamp ${entFlag} --sign "${IDENTITY}" "${path}"`);
}
const sparkleFramework = join(app, "Contents", "Frameworks", "Sparkle.framework");
const sparkleVersionsB = join(sparkleFramework, "Versions", "B");
const nestedSparkleHelpers = [
  join(sparkleVersionsB, "Autoupdate"),
  join(sparkleVersionsB, "Updater.app"),
  join(sparkleVersionsB, "XPCServices", "Downloader.xpc"),
  join(sparkleVersionsB, "XPCServices", "Installer.xpc"),
];
console.log("Re-signing Sparkle.framework's nested helper binaries (shipped ad-hoc by the SPM distribution)...");
for (const target of nestedSparkleHelpers) {
  if (!existsSync(target)) {
    console.log(`  (skip — not present in this Sparkle version: ${target})`);
    continue;
  }
  resignPreservingEntitlements(target);
}
// Re-sign the enclosing framework so its own seal picks up the freshly-signed nested content,
// then the outer app so ITS seal picks up the changed nested framework.
resignPreservingEntitlements(sparkleFramework);
resignPreservingEntitlements(app);
console.log("Sparkle.framework nested helpers + framework + outer app re-signed.");

// ---------------------------------------------------------------------------
// 4. Verify signatures BEFORE spending a notarization submission on a bad build.
// ---------------------------------------------------------------------------
console.log("Verifying signatures...");
try {
  sh(`codesign --verify --deep --strict "${app}"`);
} catch {
  fail(`codesign --verify --deep --strict failed on ${app}`);
}
function assertSigned(path: string, label: string) {
  if (!existsSync(path)) fail(`${label} not found at ${path} — build did not embed it as expected`);
  const out = probe(`codesign -dvv "${path}" 2>&1`).stdout;
  if (!out.includes(`TeamIdentifier=${TEAM_ID}`)) {
    fail(`${label}: TeamIdentifier mismatch (expected ${TEAM_ID}):\n${out}`);
  }
  if (!/^Timestamp=/m.test(out)) {
    fail(`${label}: missing secure timestamp (notarization will reject this):\n${out}`);
  }
}
assertSigned(app, "Norma.app");
assertSigned(join(app, "Contents", "Resources", "norma-core"), "norma-core");
assertSigned(join(app, "Contents", "MacOS", "NormaHelper"), "NormaHelper");
assertSigned(sparkleFramework, "Sparkle.framework");
for (const target of nestedSparkleHelpers) {
  if (existsSync(target)) assertSigned(target, `Sparkle.framework nested helper (${target.split("/").pop()})`);
}
console.log(
  "Signatures verified: codesign --verify --deep --strict PASS; TeamIdentifier + secure timestamp confirmed on app + norma-core + NormaHelper + Sparkle.framework + its nested helpers.",
);

// ---------------------------------------------------------------------------
// 5. ditto zip for notarization submission.
// ---------------------------------------------------------------------------
console.log("Creating zip for notarization submission...");
const zipPath = join(OUT, `Norma-${version}.zip`);
rmSync(zipPath, { force: true });
sh(`ditto -c -k --sequesterRsrc --keepParent "${app}" "${zipPath}"`);

// ---------------------------------------------------------------------------
// 6. Notarize. `--wait` blocks until Apple finishes processing; `--output-format json` gives
//    a single parseable blob at the end instead of a progress stream.
// ---------------------------------------------------------------------------
interface NotarizeResult {
  id?: string;
  status?: string;
  message?: string;
}
function notarizeSubmit(path: string): NotarizeResult {
  const cmd = `xcrun notarytool submit "${path}" --keychain-profile ${NOTARY_PROFILE} --wait --output-format json`;
  try {
    const raw = execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    return JSON.parse(raw) as NotarizeResult;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    try {
      return JSON.parse(err.stdout ?? "") as NotarizeResult;
    } catch {
      fail(`notarytool submit failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
  }
}
console.log("Submitting for notarization (can take 1-15 minutes; --wait blocks until done)...");
const submission = notarizeSubmit(zipPath);
console.log(`Submission ${submission.id}: ${submission.status}`);
if (submission.status !== "Accepted") {
  if (submission.id) {
    console.error(`notarytool log ${submission.id}:`);
    try {
      console.error(sh(`xcrun notarytool log ${submission.id} --keychain-profile ${NOTARY_PROFILE}`));
    } catch (e) {
      console.error(`(failed to fetch notarization log: ${e})`);
    }
  }
  fail(`notarization did not succeed: status=${submission.status} message=${submission.message ?? ""}`);
}

// ---------------------------------------------------------------------------
// 7. Staple the ticket to the app, then RE-ZIP the stapled app as the final enclosure —
//    replaces the pre-staple zip (the enclosure Sparkle/humans download must be the stapled
//    bundle, so a plain online Gatekeeper check works even fully offline).
// ---------------------------------------------------------------------------
console.log("Stapling notarization ticket...");
sh(`xcrun stapler staple "${app}"`);

console.log("Re-zipping the stapled app as the final enclosure (replaces the pre-staple zip)...");
rmSync(zipPath, { force: true });
sh(`ditto -c -k --sequesterRsrc --keepParent "${app}" "${zipPath}"`);

// ---------------------------------------------------------------------------
// 8. Gates: spctl must now PASS (it correctly failed pre-notarization per T1's baseline);
//    stapler validate confirms the ticket is actually attached, not just requested.
// ---------------------------------------------------------------------------
console.log("Gate: spctl --assess --type execute...");
const spctl = probe(`spctl --assess --type execute "${app}" 2>&1`);
console.log(`  ${spctl.stdout.trim()}`);
if (!spctl.ok) fail(`spctl --assess rejected ${app} even after stapling`);

console.log("Gate: stapler validate...");
const staplerValidate = probe(`xcrun stapler validate "${app}" 2>&1`);
console.log(`  ${staplerValidate.stdout.trim()}`);
if (!staplerValidate.ok) fail(`stapler validate failed on ${app}`);

console.log("Gates passed: spctl --assess PASS, stapler validate PASS.");

// ---------------------------------------------------------------------------
// 9. Dry-run boundary. T3 continues past here with DMG + appcast + publish.
// ---------------------------------------------------------------------------
if (DRY_RUN) {
  console.log(`
Artifacts:
  App: ${app}
  Zip: ${zipPath}
  Version: ${version}
  Notarization submission: ${submission.id} (${submission.status})

DRY RUN: stopping before DMG/publish (T3)
`);
  process.exit(0);
}

fail(
  "publish path not implemented yet — T3 extends this script past the dry-run boundary (DMG, appcast, gh release, tag); re-run with --dry-run",
);
