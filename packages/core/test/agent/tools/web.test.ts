import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { registerWebTools, ssrfGuard, htmlToText, followRedirects } from "../../../src/agent/tools/web";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-webfetch-")));
}

// --- Step 1: pure-fn tests (no live network) -------------------------------------------------

describe("ssrfGuard", () => {
  test("rejects non-http(s), localhost, private/link-local/loopback IPs", () => {
    for (const bad of ["ftp://x.com", "http://localhost/x", "http://127.0.0.1", "http://10.0.0.5", "http://172.16.9.1", "http://192.168.1.1", "http://169.254.1.1", "http://[::1]/", "file:///etc/passwd"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
    expect(ssrfGuard("https://example.com/page")).toBeNull();
  });

  test("rejects trailing-dot FQDN bypass of localhost/.local/IPv4 checks", () => {
    for (const bad of ["http://localhost./x", "http://foo.local./x", "http://10.0.0.1./x"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("still allows a trailing dot on a genuinely public hostname", () => {
    expect(ssrfGuard("https://example.com.")).toBeNull();
  });

  test("rejects bracketed IPv6 link-local/unique-local literals (brackets previously made these structurally dead)", () => {
    for (const bad of ["http://[fe80::1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("still allows public domains that merely START with fc/fd/fe80 (the ULA/link-local check is IPv6-literal-only)", () => {
    for (const ok of ["https://fcc.gov/", "https://fdic.gov/", "https://fc-barcelona.com/", "https://fe80.example.com/"]) {
      expect(ssrfGuard(ok)).toBeNull();
    }
  });

  test("rejects IPv4-mapped IPv6 loopback/private addresses (dotted and canonical hex forms)", () => {
    for (const bad of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:10.0.0.5]/"]) {
      expect(ssrfGuard(bad)).not.toBeNull();
    }
  });

  test("rejects the IPv6 unspecified address", () => {
    expect(ssrfGuard("http://[::]/")).not.toBeNull();
  });
});

describe("htmlToText", () => {
  // Verbatim task-5-brief.md input, EXPECTED VALUE CORRECTED: the code's own comment ("structure
  // worth keeping (user design): headings → #") plus the .md save target both confirm headings
  // convert to "# text", not plain text — the brief's illustrative expected string was stale.
  test("strips tags/scripts/styles, decodes entities, keeps text, converts headings to markdown", () => {
    expect(htmlToText("<html><script>x()</script><body><h1>Hi &amp; bye</h1><p>a<br>b</p></body>")).toBe("# Hi & bye\na\nb");
  });

  test("converts links to 'text (url)' and list items to '- text'", () => {
    expect(htmlToText('<a href="https://x.com">click</a>')).toBe("click (https://x.com)");
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  test("does not create false bullet points from <link> tags", () => {
    const html = '<html><head><link rel="icon" href="favicon.ico"><title>Page</title></head><body><p>content</p></body></html>';
    const result = htmlToText(html);
    expect(result).not.toContain("- ");
  });

  test("strips <head> section before text conversion to avoid title leakage", () => {
    const html = "<head><title>T</title></head><body><h1>H</h1>hello</body>";
    const result = htmlToText(html);
    expect(result).toBe("# H\nhello");
    expect(result).not.toContain("T");
  });
});

// --- followRedirects: fake fetch, no live network ---------------------------------------------

function fakeFetch(script: Array<{ status: number; location?: string; body?: string; contentType?: string }>): typeof fetch {
  let i = 0;
  return (async (_url: string, _init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    const headers = new Headers();
    if (step.location) headers.set("location", step.location);
    if (step.contentType) headers.set("content-type", step.contentType);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as typeof fetch;
}

describe("followRedirects", () => {
  test("302 example.com -> private IP is refused (SSRF guard re-run on the hop)", async () => {
    const fetchFn = fakeFetch([{ status: 302, location: "http://10.0.0.1/" }]);
    const res = await followRedirects("https://example.com", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("ssrf");
      const expected = ssrfGuard("http://10.0.0.1/");
      expect(expected).not.toBeNull();
      expect(res.error).toBe(expected as string);
    }
  });

  test("302 -> 302 -> 200 returns the final body", async () => {
    const fetchFn = fakeFetch([
      { status: 302, location: "https://example.com/step2" },
      { status: 302, location: "https://example.com/step3" },
      { status: 200, body: "final body", contentType: "text/plain" },
    ]);
    const res = await followRedirects("https://example.com/step1", { fetchFn });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toBe("final body");
      expect(res.url).toBe("https://example.com/step3");
      expect(res.status).toBe(200);
    }
  });

  test("more than 3 redirect hops is a typed error", async () => {
    const fetchFn = fakeFetch([
      { status: 302, location: "https://example.com/1" },
      { status: 302, location: "https://example.com/2" },
      { status: 302, location: "https://example.com/3" },
      { status: 302, location: "https://example.com/4" },
      { status: 200, body: "unreached" },
    ]);
    const res = await followRedirects("https://example.com/0", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("redirects");
  });

  test("public first hop redirecting into an IPv4-mapped IPv6 loopback is refused mid-chain", async () => {
    const fetchFn = fakeFetch([{ status: 302, location: "http://[::ffff:127.0.0.1]/" }]);
    const res = await followRedirects("https://example.com", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("ssrf");
      const expected = ssrfGuard("http://[::ffff:127.0.0.1]/");
      expect(expected).not.toBeNull();
      expect(res.error).toBe(expected as string);
    }
  });

  test("non-2xx after redirects resolve is 'fetch failed: <status>'", async () => {
    const fetchFn = fakeFetch([{ status: 404, body: "not found" }]);
    const res = await followRedirects("https://example.com/missing", { fetchFn });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("fetch failed: 404");
      expect(res.kind).toBe("http");
    }
  });
});

// --- web_fetch tool: save-to-file + result shape + audit ---------------------------------------

describe("web_fetch tool", () => {
  test("writes the full converted text to ctx.tmpDir and returns a header+preview+guidance result, preview <= 8192 bytes", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    const html = "<html><body><h1>Example Domain</h1><p>This domain is for illustrative examples.</p></body></html>";
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: html, contentType: "text/html; charset=utf-8" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);

    const savedMatch = out.output.match(/^Saved to: (.+)$/m);
    expect(savedMatch).not.toBeNull();
    const savedPath = savedMatch![1]!;
    expect(existsSync(savedPath)).toBe(true);
    const fileContent = readFileSync(savedPath, "utf8");
    expect(fileContent).toBe("# Example Domain\nThis domain is for illustrative examples.");

    expect(out.output).toContain("Title: Example Domain");
    expect(out.output).toContain("--- preview (first 8192 bytes) ---");
    expect(out.output).toContain("--- end preview ---");
    expect(out.output).toContain("Use read with offset/limit to page through it, grep to search it, or spawn_agent to digest it.");

    const previewSection = out.output.split("--- preview (first 8192 bytes) ---\n")[1]!.split("\n--- end preview ---")[0]!;
    expect(Buffer.byteLength(previewSection, "utf8")).toBeLessThanOrEqual(8192);

    expect(audited.length).toBe(1);
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_fetch", url: "https://example.com/", outcome: "ok" });
  });

  test("non-html content-type is saved and returned as raw text (no htmlToText conversion)", async () => {
    const r = new ToolRegistry();
    registerWebTools(r, { fetchFn: fakeFetch([{ status: 200, body: "plain text body", contentType: "text/plain" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/raw" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Title: -");
    const savedPath = out.output.match(/^Saved to: (.+)$/m)![1]!;
    expect(readFileSync(savedPath, "utf8")).toBe("plain text body");
  });

  test("SSRF refusal is a typed error AND is audited with outcome ssrf_refused", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "http://10.0.0.5/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("refusing to fetch a private address");
    expect(audited.length).toBe(1);
    expect(audited[0]).toMatchObject({ kind: "network", tool: "web_fetch", url: "http://10.0.0.5/", outcome: "ssrf_refused" });
  });

  test("non-2xx HTTP error is a typed error AND is audited with outcome http_error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 500, body: "boom" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/broken" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.output).toBe("fetch failed: 500");
    expect(audited[0]).toMatchObject({ outcome: "http_error" });
  });

  test("audit includes finalUrl (distinct from requested url) when a redirect chain resolves elsewhere", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, {
      audit: (l) => audited.push(l),
      fetchFn: fakeFetch([
        { status: 302, location: "https://example.com/final" },
        { status: 200, body: "final body", contentType: "text/plain" },
      ]),
    });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/start" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(false);
    expect(audited[0]).toMatchObject({ url: "https://example.com/start", finalUrl: "https://example.com/final", outcome: "ok" });
  });

  test("a successful fetch followed by a file-write failure is audited as write_error, not network_error", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: "x", contentType: "text/plain" }]) });
    const dir = tmp();
    // ctx.tmpDir points INTO a regular file — mkdirSync(recursive) throws ENOTDIR, simulating a
    // write-time failure that happens strictly after the fetch already succeeded.
    const blockerFile = join(dir, "not-a-dir");
    writeFileSync(blockerFile, "x");
    const badTmpDir = join(blockerFile, "sub");
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: badTmpDir });
    expect(out.isError).toBe(true);
    expect(audited[0]).toMatchObject({ outcome: "write_error" });
  });

  test("missing ctx.tmpDir is a typed error (audited too)", async () => {
    const r = new ToolRegistry();
    const audited: Record<string, unknown>[] = [];
    registerWebTools(r, { audit: (l) => audited.push(l), fetchFn: fakeFetch([{ status: 200, body: "x" }]) });
    const dir = tmp();
    const out = await r.execute("web_fetch", { url: "https://example.com/" }, { cwd: dir, roots: [dir], sessionId: "s1" });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("ctx.tmpDir is unset");
    expect(audited[0]).toMatchObject({ outcome: "no_tmp_dir" });
  });

  test("bad args (missing url) is a registry-level tool error, not a throw", async () => {
    const r = new ToolRegistry();
    registerWebTools(r);
    const dir = tmp();
    const out = await r.execute("web_fetch", {}, { cwd: dir, roots: [dir], sessionId: "s1", tmpDir: dir });
    expect(out.isError).toBe(true);
  });
});
