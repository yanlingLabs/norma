import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

export const LAUNCHD_LABEL = "com.norma.core";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(opts: { binaryPath: string; normaHome: string }): string {
  const home = xmlEscape(opts.normaHome);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.binaryPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>NORMA_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(opts.normaHome, "logs", "core.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(opts.normaHome, "logs", "core.err.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
  return { ok: (await proc.exited) === 0, out };
}

export async function installDaemon(binaryPath: string, normaHome: string): Promise<void> {
  writeFileSync(plistPath(), renderPlist({ binaryPath, normaHome }));
  const uid = process.getuid!();
  await launchctl("bootout", `gui/${uid}/${LAUNCHD_LABEL}`); // ignore failures: may not be loaded
  const res = await launchctl("bootstrap", `gui/${uid}`, plistPath());
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out}`);
}

export async function uninstallDaemon(): Promise<void> {
  await launchctl("bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`);
  if (existsSync(plistPath())) unlinkSync(plistPath());
}

export async function daemonStatus(): Promise<string> {
  const res = await launchctl("print", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`);
  return res.ok ? "loaded" : "not loaded";
}

/** Injectable seams for `migrateFromLaunchdAgent` — real filesystem/launchctl by default, fakes in
 * tests. Never touches a real user's home directory or launchd from a test process. */
export interface MigrateLaunchdDeps {
  plistPath?: string;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
  bootout?: (label: string) => Promise<void>;
}

/** Lifecycle T4: tears down the OLD `com.norma.core` launchd agent (superseded by the app's
 * `DaemonSupervisor` embedding norma-core directly). A leftover `KeepAlive` agent would otherwise
 * relaunch a daemon the app just killed, defeating the app↔daemon lifecycle coupling entirely — so
 * this must run before/at app-driven daemon supervision starts. No-op if the plist was never
 * installed (fresh installs, or a machine already migrated). NEVER throws: a failed bootout/unlink
 * (e.g. permissions, already gone) must not block the app from starting. */
export async function migrateFromLaunchdAgent(deps: MigrateLaunchdDeps = {}): Promise<void> {
  const path = deps.plistPath ?? plistPath();
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? unlinkSync;
  const bootout = deps.bootout ?? (async (label: string) => {
    await launchctl("bootout", `gui/${process.getuid!()}/${label}`);
  });
  try {
    if (!exists(path)) return; // never installed (or already migrated) — nothing to do
    await bootout(LAUNCHD_LABEL);
    remove(path);
  } catch (error) {
    console.error(`[launchd] migrateFromLaunchdAgent failed (non-fatal): ${error}`);
  }
}
