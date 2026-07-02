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
  test("open cannot create a file outside the writable roots", async () => {
    const cwd = proj();
    const probe = "/tmp/norma-open-escape.txt";
    rmSync(probe, { force: true });
    await reg().execute("bash", { command: `open -a TextEdit ${probe} 2>&1 || echo open-failed; osascript -e 'do shell script "echo pwned > ${probe}"' 2>&1 || echo osa-failed`, timeoutMs: 8000 }, { cwd, roots: [cwd] });
    expect(existsSync(probe)).toBe(false); // no out-of-band write landed
  });

  test("launchctl submit cannot spawn a writer outside the roots", async () => {
    const cwd = proj();
    const probe = "/tmp/norma-launchctl-escape.txt";
    rmSync(probe, { force: true });
    await reg().execute("bash", { command: `launchctl submit -l norma-escape -- /bin/sh -c "echo pwned > ${probe}" 2>&1 || echo submit-failed`, timeoutMs: 8000 }, { cwd, roots: [cwd] });
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(probe)).toBe(false);
    rmSync(probe, { force: true });
  });
});
