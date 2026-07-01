import { realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

export interface SandboxOptions {
  cwd: string;                 // session working directory — always a writable root
  writableRoots?: string[];    // extra writable subpaths (default: [os.tmpdir()])
  allowNetwork?: boolean;      // default false
}

/** Escape a path for embedding inside an SBPL double-quoted string literal. */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** realpath a path if it exists (canonicalizes macOS /tmp and /var symlinks); pass through otherwise. */
function canon(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere,
 * write only under the given roots, network denied unless opted in.
 */
export function buildSeatbeltProfile(opts: SandboxOptions): string {
  const roots = [opts.cwd, ...(opts.writableRoots ?? [tmpdir()])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");
  const network = opts.allowNetwork ? "(allow network*)" : "(deny network*)";
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write*
${writeRules})
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/dtracehelper"))
${network}
`;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}
