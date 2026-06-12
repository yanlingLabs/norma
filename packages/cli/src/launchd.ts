import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

export const LAUNCHD_LABEL = "com.norma.core";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function renderPlist(opts: { binaryPath: string; normaHome: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.binaryPath}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>NORMA_HOME</key><string>${opts.normaHome}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(opts.normaHome, "logs", "core.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(opts.normaHome, "logs", "core.err.log")}</string>
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
