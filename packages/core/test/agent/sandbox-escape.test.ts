import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { sandboxAvailable } from "../../src/agent/sandbox";

const d = sandboxAvailable() ? describe : describe.skip;
function reg() { const r = new ToolRegistry(); registerBashTool(r); return r; }
function proj() { return realpathSync(mkdtempSync(join(tmpdir(), "norma-esc-"))); }

d("sandbox escape probes are contained", () => {
  // NOTE: `open -a TextEdit <path>` was previously used here as a probe, but it's a dead
  // vector regardless of sandboxing: `open` errors with "does not exist" for a nonexistent
  // path and never creates it (verified unsandboxed too) — so it "passed" for the wrong
  // reason (a no-op, not a denial). osascript's `do shell script` genuinely writes via a
  // privileged helper (System Events), so it's the real probe here. These vectors were
  // already contained pre-tightening (the mach-lookup allowlist is defense-in-depth on
  // top of the deny-by-default write rules); this test pins containment of the write
  // rules, not the mach-lookup allowlist specifically.
  test("osascript do-shell-script cannot create a file outside the writable roots", async () => {
    const cwd = proj();
    const probe = "/tmp/norma-osascript-escape.txt";
    rmSync(probe, { force: true });
    await reg().execute("bash", { command: `osascript -e 'do shell script "echo pwned > ${probe}"' 2>&1 || echo osa-failed`, timeoutMs: 8000 }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(existsSync(probe)).toBe(false); // no out-of-band write landed
  });

  test("launchctl submit cannot spawn a writer outside the roots", async () => {
    const cwd = proj();
    const probe = "/tmp/norma-launchctl-escape.txt";
    rmSync(probe, { force: true });
    await reg().execute("bash", { command: `launchctl submit -l norma-escape -- /bin/sh -c "echo pwned > ${probe}" 2>&1 || echo submit-failed`, timeoutMs: 8000 }, { cwd, roots: [cwd], sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(probe)).toBe(false);
    rmSync(probe, { force: true });
  });
});
