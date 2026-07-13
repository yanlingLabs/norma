import { spawn, type ChildProcess } from "node:child_process";

// Minimal LSP stdio client: JSON-RPC over child-process stdio, Content-Length framed (LSP's
// wire format is byte-counted, NOT line-delimited — unlike this repo's `mcp/client.ts`, whose
// buffering/pending-map/dead-state architecture this file otherwise mirrors). Diagnostics are
// server-PUSH (`textDocument/publishDiagnostics`, no id); definitions/references are ordinary
// id-correlated requests. Every await here is bounded by a typed-error timeout; a mid-session
// child exit or process error rejects every pending request/diagnostics waiter — callers never
// hang a turn on a wedged or crashed language server.

export interface LspLocation { path: string; line: number; character: number } // 0-based, as LSP returns
export interface LspDiagnostic { line: number; character: number; severity: 1 | 2 | 3 | 4; message: string; source?: string } // 0-based

// A junk env value must fall back to the default, not become NaN — setTimeout(fn, NaN) fires
// immediately, which would silently zero every bound below.
function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_START_TIMEOUT_MS = envNum("NORMA_LSP_START_TIMEOUT_MS", 10000);
const DEFAULT_REQUEST_TIMEOUT_MS = envNum("NORMA_LSP_REQUEST_TIMEOUT_MS", 10000);
const DEFAULT_DIAG_TIMEOUT_MS = envNum("NORMA_LSP_DIAG_TIMEOUT_MS", 5000);
// Diagnostics settle window: real servers publish MORE THAN ONCE per didOpen (tsserver runs a fast
// syntactic pass first and the semantic pass later, as separate publishes — the first is often
// empty even when the file has a type error). diagnostics() therefore resolves with the LATEST
// publish once no further publish has arrived for this long — never with the first one blindly.
const DEFAULT_DIAG_SETTLE_MS = envNum("NORMA_LSP_DIAG_SETTLE_MS", 400);
const STOP_TIMEOUT_MS = envNum("NORMA_LSP_STOP_TIMEOUT_MS", 5000);
const STDERR_TAIL_MAX = 2000; // cap so a chatty server can't grow this unbounded across a long session

/** A request/diagnostics-wait didn't settle within its bound. Distinguishes "still waiting" from
 *  every other rejection so callers can retry/report a hang specifically. */
export class LspTimeoutError extends Error { constructor(message: string) { super(message); this.name = "LspTimeoutError"; } }
/** The server process exited (or errored on spawn) while requests/waiters were pending. */
export class LspServerExitedError extends Error { constructor(message: string) { super(message); this.name = "LspServerExitedError"; } }
/** `start()`/`diagnostics()`/`definition()`/`references()` called after `stop()` or a death. */
export class LspNotRunningError extends Error { constructor(message = "lsp server is not running") { super(message); this.name = "LspNotRunningError"; } }
/** The server answered a request with a JSON-RPC `error` object. */
export class LspRequestError extends Error { constructor(message: string, public readonly code?: number) { super(message); this.name = "LspRequestError"; } }

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function languageIdForUri(uri: string): string {
  const ext = /\.([a-zA-Z0-9]+)$/.exec(uri)?.[1]?.toLowerCase();
  switch (ext) {
    case "ts": case "mts": case "cts": return "typescript";
    case "tsx": return "typescriptreact";
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "javascriptreact";
    case "swift": return "swift";
    default: return "plaintext";
  }
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri; // defensive: pass through non-file URIs unchanged
  let p = decodeURIComponent(uri.slice("file://".length));
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // file:///C:/foo → C:/foo
  return p;
}

// LSP's textDocument/definition (etc.) result is Location | Location[] | LocationLink[] | null;
// LocationLink uses targetUri/targetSelectionRange instead of uri/range.
function toLocations(res: unknown): LspLocation[] {
  if (res == null) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.map((loc: any) => {
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    return { path: uriToPath(uri), line: range?.start?.line ?? 0, character: range?.start?.character ?? 0 };
  });
}

function toDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => ({
    line: d.range?.start?.line ?? 0,
    character: d.range?.start?.character ?? 0,
    severity: (d.severity ?? 1) as 1 | 2 | 3 | 4,
    message: String(d.message ?? ""),
    ...(d.source ? { source: String(d.source) } : {}),
  }));
}

interface Settler<T> { resolve: (v: T) => void; reject: (e: Error) => void }

/** One diagnostics() call awaiting a SETTLED result for its URI. `latest` accumulates across
 *  publishes; `settle` is the quiet-period timer (re-armed on every publish); `deadline` is the
 *  overall bound. Exactly one of the three finish paths runs (guarded by `done`): settle elapsed →
 *  resolve(latest); deadline with data → resolve(latest); deadline with no data → reject(timeout). */
interface DiagWaiter {
  resolve: (v: LspDiagnostic[]) => void;
  reject: (e: Error) => void;
  latest: LspDiagnostic[] | null;
  settle: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class LspClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private buf: Buffer = Buffer.alloc(0);
  private pending = new Map<number, Settler<any>>();
  // diagnostics() calls currently awaiting a SETTLED result for their URI — each publish updates
  // every waiter's `latest` and re-arms its settle timer (see DiagWaiter). Waiters are removed on
  // finish, not on first publish: real servers publish repeatedly per didOpen. There is deliberately
  // NO cross-call cache: each diagnostics() re-opens the on-disk content and settles fresh.
  private diagWaiters = new Map<string, DiagWaiter[]>();
  private openUris = new Set<string>();
  private stderrTail = "";
  private _dead = false;

  constructor(private readonly cfg: { command: string; args?: string[]; rootUri: string; startTimeoutMs?: number; diagSettleMs?: number; diagTimeoutMs?: number }) {}

  get alive(): boolean { return !this._dead; }

  async start(): Promise<void> {
    const timeoutMs = this.cfg.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const child = spawn(this.cfg.command, this.cfg.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.on("error", (e) => this.die(new LspServerExitedError(this.withStderr(`lsp server failed to start: ${e.message}`))));
    child.on("exit", (code, signal) => this.die(new LspServerExitedError(this.withStderr(`lsp server exited (code=${code} signal=${signal})`))));
    child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => {
      this.stderrTail = (this.stderrTail + s).slice(-STDERR_TAIL_MAX);
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: this.cfg.rootUri,
      capabilities: { textDocument: { publishDiagnostics: {}, definition: {}, references: {} } },
      workspaceFolders: [{ uri: this.cfg.rootUri, name: "root" }],
    }, timeoutMs);
    this.notify("initialized", {});
  }

  async diagnostics(fileUri: string, text: string, timeoutMs = this.cfg.diagTimeoutMs ?? DEFAULT_DIAG_TIMEOUT_MS): Promise<LspDiagnostic[]> {
    if (this._dead) return Promise.reject(new LspNotRunningError());
    const settleMs = this.cfg.diagSettleMs ?? DEFAULT_DIAG_SETTLE_MS;
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const w: DiagWaiter = { resolve, reject, latest: null, settle: null, deadline: null, done: false };
      // Overall bound: with at least one publish in hand, resolve with it — interim data beats a
      // timeout error; a server still churning past the deadline gave us its best answer so far.
      // With NOTHING in hand, this is the genuine "server never published" hang → typed timeout.
      w.deadline = setTimeout(() => {
        if (w.latest !== null) this.finishDiag(fileUri, w, { ok: true, value: w.latest });
        else this.finishDiag(fileUri, w, { ok: false, error: new LspTimeoutError(`diagnostics for ${fileUri} timed out after ${timeoutMs}ms`) });
      }, timeoutMs);
      const waiters = this.diagWaiters.get(fileUri) ?? [];
      waiters.push(w);
      this.diagWaiters.set(fileUri, waiters);
      this.sendDidOpen(fileUri, text);
    });
  }

  /** Exactly-once finish for a diagnostics waiter: clears BOTH timers, removes it from the map,
   *  and settles its promise. Every path (settle elapsed, deadline, die()) funnels through here. */
  private finishDiag(uri: string, w: DiagWaiter, outcome: { ok: true; value: LspDiagnostic[] } | { ok: false; error: Error }): void {
    if (w.done) return;
    w.done = true;
    if (w.settle !== null) clearTimeout(w.settle);
    if (w.deadline !== null) clearTimeout(w.deadline);
    const list = this.diagWaiters.get(uri);
    if (list) {
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.diagWaiters.delete(uri);
    }
    if (outcome.ok) w.resolve(outcome.value);
    else w.reject(outcome.error);
  }

  async definition(fileUri: string, line: number, character: number): Promise<LspLocation[]> {
    const res = await this.request("textDocument/definition", { textDocument: { uri: fileUri }, position: { line, character } }, DEFAULT_REQUEST_TIMEOUT_MS);
    return toLocations(res);
  }

  async references(fileUri: string, line: number, character: number): Promise<LspLocation[]> {
    const res = await this.request(
      "textDocument/references",
      { textDocument: { uri: fileUri }, position: { line, character }, context: { includeDeclaration: true } },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    return toLocations(res);
  }

  async stop(): Promise<void> {
    if (this._dead || !this.child) { this._dead = true; return; }
    const child = this.child;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
    });
    // Fire-and-forget: an unresponsive server's OWN internal request-timeout must NOT gate the
    // kill decision below. Earlier draft awaited this before racing against the outer timer —
    // since both used STOP_TIMEOUT_MS and the inner one is armed a tick earlier, it always won
    // the race and `clearTimeout`'d the outer timer, so SIGKILL never ran (a real server that
    // never responds to anything leaked its child process past the test — caught via `pgrep`
    // in an unrelated bash-tool test). The exit race below is the ONLY thing that decides kill.
    this.request("shutdown", {}, STOP_TIMEOUT_MS).then(() => this.notify("exit", {})).catch(() => { /* unresponsive; the race below force-kills regardless */ });
    await withTimeout(exited, STOP_TIMEOUT_MS, () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      return new LspTimeoutError("lsp did not exit after shutdown; force-killed");
    }).catch(() => { /* stop() is always best-effort and never throws; the process is dead or killed either way */ });
    this.die(new LspServerExitedError("stopped"));
  }

  /** SYNCHRONOUS best-effort kill — the daemon-SIGTERM backstop (5f whole-branch review). Unlike
   *  `stop()` (whose graceful shutdown request AND SIGKILL fallback are BOTH async — a `.then()`
   *  exit notification and a `STOP_TIMEOUT_MS` timer callback), this delivers a REAL `SIGTERM` to
   *  the child in the SAME synchronous tick, so it survives a `process.exit(0)` that runs
   *  immediately after (mirrors `mcp/client.ts`'s synchronous `stop()`). `die()` rejects every
   *  pending request/diagnostics waiter, which clears their per-request timeout timers. Idempotent
   *  and safe on an already-dead/never-started client (`die()` guards on `_dead`; `kill` on a gone
   *  child is caught). */
  killNow(): void {
    try { this.child?.stdin?.end(); } catch { /* ignore */ }
    try { this.child?.kill("SIGTERM"); } catch { /* already gone */ }
    this.die(new LspServerExitedError("killed"));
  }

  private sendDidOpen(uri: string, text: string): void {
    // LSP forbids re-opening an already-open document; close first so repeat diagnostics()
    // calls for the same uri (e.g. re-checking after an edit) stay protocol-legal.
    if (this.openUris.has(uri)) this.notify("textDocument/didClose", { textDocument: { uri } });
    this.openUris.add(uri);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageIdForUri(uri), version: 1, text } });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this._dead) return Promise.reject(new LspNotRunningError());
    const id = this.nextId++;
    const raw = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }); // a synchronous throw here auto-rejects `raw` (Promise executor semantics)
    });
    return withTimeout(raw, timeoutMs, () => {
      this.pending.delete(id);
      return new LspTimeoutError(`lsp request "${method}" timed out after ${timeoutMs}ms`);
    });
  }

  private notify(method: string, params: unknown): void {
    try { this.send({ jsonrpc: "2.0", method, params }); } catch { /* best-effort; dead-state surfaces via pending rejections elsewhere */ }
  }

  private send(msg: unknown): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.child!.stdin!.write(header + body);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // no full header yet
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; } // malformed header; resync defensively
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return; // partial frame; wait for more data
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return; // response to an id we no longer track (already timed out) — drop silently
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new LspRequestError(String(msg.error?.message ?? "lsp error"), msg.error?.code));
      else p.resolve(msg.result);
    } else if (msg && typeof msg.method === "string") {
      this.dispatchNotification(msg.method, msg.params);
    }
  }

  private dispatchNotification(method: string, params: any): void {
    if (method !== "textDocument/publishDiagnostics") return; // v1 scope: no other server-push methods consumed
    const uri = String(params?.uri ?? "");
    const diags = toDiagnostics(params?.diagnostics);
    const waiters = this.diagWaiters.get(uri);
    if (!waiters || waiters.length === 0) return; // late publish after every waiter finished — drop
    const settleMs = this.cfg.diagSettleMs ?? DEFAULT_DIAG_SETTLE_MS;
    // Do NOT resolve on this publish: real servers publish more than once per didOpen (tsserver's
    // syntactic pass lands first and is often empty even when a type error follows). Record it as
    // the latest answer and (re)arm the quiet-period timer; the waiter resolves only once no
    // further publish has arrived for settleMs (or its overall deadline fires with data in hand).
    for (const w of [...waiters]) {
      w.latest = diags;
      if (w.settle !== null) clearTimeout(w.settle);
      w.settle = setTimeout(() => this.finishDiag(uri, w, { ok: true, value: w.latest! }), settleMs);
    }
  }

  private withStderr(message: string): string {
    return this.stderrTail ? `${message}: ${this.stderrTail}` : message;
  }

  private die(err: Error): void {
    if (this._dead) return;
    this._dead = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    // Snapshot per-URI lists: finishDiag splices the live arrays as it settles each waiter.
    for (const [uri, arr] of [...this.diagWaiters.entries()]) {
      for (const w of [...arr]) this.finishDiag(uri, w, { ok: false, error: err });
    }
    this.diagWaiters.clear();
  }
}
