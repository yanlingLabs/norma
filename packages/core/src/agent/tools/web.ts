import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistry } from "./registry";

const MAX_FETCH_BYTES = 5 * 1024 * 1024; // hard cap on bytes READ off the wire (streamed — see readCapped)
const PREVIEW_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 3;

// module-level, per-process — names saved files webfetch-<n>-<host>.md (USER DESIGN, task-5-brief.md)
let fetchCounter = 0;

/** Norma's ONLY sanctioned network egress (spec 4g §4.3) — bash stays sandboxed (network denied).
 *  v1 SSRF posture: literal private/loopback/link-local hosts rejected; DNS-rebinding is out of
 *  scope (documented). Response bytes are DATA, never instructions. */
export function ssrfGuard(raw: string): string | null {
  let u: URL; try { u = new URL(raw); } catch { return `invalid url: ${raw}`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `only http(s) urls are allowed`;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1" || h === "[::1]") return `refusing to fetch a local address`;
  const ip4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip4) { const [a, b] = [Number(ip4[1]), Number(ip4[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return `refusing to fetch a private address`; }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return `refusing to fetch a private address`;
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    // structure worth keeping (user design): headings → #, links → text (url), list items → "- "
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${"#".repeat(Number(n))} ${t}\n`)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `${t} (${href})`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

/** Title extraction happens on the RAW html, before htmlToText runs on the whole page (which
 *  destroys the tags this looks for). Reuses htmlToText only on the small extracted h1/title
 *  snippet — that's just tag-stripping + entity-decoding, not the whole-page conversion. */
function extractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const src = h1?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!src) return "-";
  const text = htmlToText(src).replace(/\n+/g, " ").trim();
  return text || "-";
}

/** Reads a Response body up to `capBytes`, cancelling the underlying stream once the cap is hit —
 *  truncation happens DURING collection (never read-then-slice), so a multi-GB response can't OOM
 *  the daemon before the cap applies. Mirrors bash.ts's MAX_CAPTURE streaming-truncation pattern —
 *  Norma's only network egress gets the same discipline bash's output capture already has. */
async function readCapped(res: Response, capBytes: number): Promise<{ text: string; bytesRead: number }> {
  if (!res.body) {
    const text = await res.text();
    const buf = Buffer.from(text, "utf8");
    return buf.byteLength > capBytes
      ? { text: buf.subarray(0, capBytes).toString("utf8"), bytesRead: capBytes }
      : { text, bytesRead: buf.byteLength };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      chunks.push(value);
      if (total >= capBytes) {
        try { await reader.cancel(); } catch { /* stream already closing */ }
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
  const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const bytesRead = Math.min(combined.byteLength, capBytes);
  return { text: combined.subarray(0, capBytes).toString("utf8"), bytesRead };
}

export interface FollowRedirectsOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  maxHops?: number;
}
export interface FetchSuccess { ok: true; url: string; status: number; contentType: string; body: string; bytesRead: number }
export interface FetchFailure { ok: false; error: string; kind: "ssrf" | "redirects" | "http" | "timeout" | "network" }
export type FollowResult = FetchSuccess | FetchFailure;

/** SSRF-guarded manual-redirect loop: guards EVERY hop (including the first) — a compliant first
 *  URL must not be able to 302 into a private address. `fetchFn` is injectable so tests drive this
 *  with a fake (no live network in unit tests); it defaults to the global fetch. */
export async function followRedirects(startUrl: string, opts: FollowRedirectsOptions = {}): Promise<FollowResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  let current = startUrl;
  for (let redirects = 0; ; redirects++) {
    const guardErr = ssrfGuard(current);
    if (guardErr) return { ok: false, error: guardErr, kind: "ssrf" };

    let res: Response;
    try {
      res = await fetchFn(current, { redirect: "manual", signal: opts.signal });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || name === "TimeoutError") {
        return { ok: false, error: `request timed out fetching ${current}`, kind: "timeout" };
      }
      return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}`, kind: "network" };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: `redirect (${res.status}) with no Location header`, kind: "http" };
      if (redirects >= maxHops) return { ok: false, error: `too many redirects (>${maxHops} hops)`, kind: "redirects" };
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `fetch failed: ${res.status}`, kind: "http" };

    const contentType = res.headers.get("content-type") ?? "";
    const { text, bytesRead } = await readCapped(res, MAX_FETCH_BYTES);
    return { ok: true, url: current, status: res.status, contentType, body: text, bytesRead };
  }
}

export interface WebToolDeps {
  /** Emits one line per call, EVERY outcome (success, ssrf-refusal, http error, timeout, ...) —
   *  matching how hardware.ts audits (peripheral/hardware.ts's `deps.audit.append(...)`), but
   *  threaded as a plain callback (not the AuditLog class) so tests don't need a real file. */
  audit?: (line: Record<string, unknown>) => void;
  /** Test-only injection point (defaults to global fetch, same as followRedirects' own default) —
   *  lets the file-write/result-shape test drive the FULL run() through registerWebTools without
   *  live network, the same way followRedirects' own tests drive it directly. */
  fetchFn?: typeof fetch;
}

export function registerWebTools(r: ToolRegistry, deps: WebToolDeps = {}): void {
  r.register({
    name: "web_fetch",
    description:
      "Fetch a URL (http/https) and return its readable text content. Norma's only network-capable tool — bash has no network. Large pages truncate at 64KB; fetch is read-only GET.",
    // url only — no `prompt` (CC's web_fetch takes an optional page-digest prompt). Deliberate spec
    // deviation: the save-to-tmp result shape below already gives the model read/grep/spawn_agent
    // access to the FULL saved page, so a fetch-time digest prompt is redundant. Also no `max_bytes`:
    // the 5MB read cap and 8192-byte preview are fixed constants (not caller-tunable), keeping the
    // SSRF/DoS posture uniform regardless of what a caller asks for.
    args: z.object({ url: z.string().min(1) }),
    deferred: true, // T1 machinery, per-def flag — same pattern as task_get
    async run({ url }, ctx) {
      let outcome = "network_error";
      try {
        if (!ctx.tmpDir) {
          outcome = "no_tmp_dir";
          throw new Error("web_fetch requires a session tmp directory (ctx.tmpDir is unset)");
        }
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));

        const res = await followRedirects(url, { fetchFn: deps.fetchFn, signal });
        if (!res.ok) {
          outcome = res.kind === "ssrf" ? "ssrf_refused"
            : res.kind === "timeout" ? "timeout"
            : res.kind === "redirects" ? "too_many_redirects"
            : res.kind === "http" ? "http_error"
            : "network_error";
          throw new Error(res.error);
        }

        const isHtml = res.contentType.toLowerCase().includes("text/html");
        const finalText = isHtml ? htmlToText(res.body) : res.body;
        const title = isHtml ? extractTitle(res.body) : "-";

        const host = new URL(res.url).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
        const filename = `webfetch-${++fetchCounter}-${host}.md`;
        mkdirSync(ctx.tmpDir, { recursive: true });
        const savedPath = join(ctx.tmpDir, filename);
        writeFileSync(savedPath, finalText);

        const savedBytes = Buffer.byteLength(finalText, "utf8");
        const preview = Buffer.from(finalText, "utf8").subarray(0, PREVIEW_BYTES).toString("utf8");

        outcome = "ok";
        return [
          `Fetched ${res.url} (HTTP ${res.status}, ${res.contentType || "unknown content-type"}, ${res.bytesRead} bytes → ${savedBytes} bytes text)`,
          `Title: ${title}`,
          `Saved to: ${savedPath}`,
          `--- preview (first 8192 bytes) ---`,
          preview,
          `--- end preview ---`,
          `Full page saved. Use read with offset/limit to page through it, grep to search it, or spawn_agent to digest it.`,
        ].join("\n");
      } finally {
        deps.audit?.({ kind: "network", tool: "web_fetch", url, outcome });
      }
    },
  });
}
