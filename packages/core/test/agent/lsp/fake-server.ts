// Scripted LSP stdio server for deterministic client tests. Speaks REAL Content-Length
// framing (LSP wire format is byte-counted, not line-delimited — unlike this repo's MCP
// fake server) so framing edges (split writes, merged frames) are genuinely exercised
// against a real child process, not an in-memory stub.
//
// Scenarios are env-driven (set by the test spawning this via `bun run fake-server.ts`):
//   NORMA_LSP_FAKE_DIAGS              JSON array of raw LSP diagnostics to publish on didOpen
//                                     (default: one canned error diagnostic)
//   NORMA_LSP_FAKE_NO_DIAGNOSTICS=1   never publish on didOpen — exercises the client's
//                                     diagnostics() timeout path
//   NORMA_LSP_FAKE_STAGED_DIAGS=1     publish EMPTY diagnostics immediately on didOpen, then the
//                                     real NORMA_LSP_FAKE_DIAGS set ~100ms later — the shape real
//                                     tsserver produces (fast syntactic pass first, semantic pass
//                                     later as a SECOND publish). Exercises the client's settle
//                                     window: resolve-on-first-publish would wrongly return [].
//   NORMA_LSP_FAKE_DEFINITION         JSON array/object result for textDocument/definition
//   NORMA_LSP_FAKE_REFERENCES         JSON array result for textDocument/references
//   NORMA_LSP_FAKE_SPLIT=1            split the NEXT definition response body across two
//                                     stdout writes (20ms apart) — partial-frame reassembly
//   NORMA_LSP_FAKE_MERGE=1            hold the definition response until the following
//                                     references request arrives, then write BOTH frames
//                                     concatenated in a single stdout.write() call
//   NORMA_LSP_FAKE_DIE_ON=<method>    process.exit(1) the instant that method is received,
//                                     before any response is written — simulates a crash
//                                     mid-request
//   NORMA_LSP_FAKE_REQUIRE_OPEN=1     answer textDocument/definition & references with `null`
//                                     unless the target uri was didOpen'd first — mirrors real
//                                     servers (tsserver/sourcekit-lsp) that only resolve positions
//                                     for open documents. Exercises the client's ensure-open gate.

export {}; // force module scope — a top-level script here would collide with fake-mcp-server.ts's
// own global `buf`/`send`/`handle` bindings under tsc (both are otherwise-import-free scripts).

function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}
function send(msg: unknown): void { process.stdout.write(frame(msg)); }

// Splits an already-built frame's BODY in half so write #1 ends mid-body: the client's
// reader must accumulate across the 20ms gap before a full Content-Length frame exists.
function sendSplitBody(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  const cut = Math.max(1, Math.floor(body.length / 2));
  process.stdout.write(Buffer.concat([header, body.subarray(0, cut)]));
  setTimeout(() => process.stdout.write(body.subarray(cut)), 20);
}

let heldDefinitionFrame: Buffer | null = null;
const openUris = new Set<string>(); // tracks didOpen'd docs for NORMA_LSP_FAKE_REQUIRE_OPEN

function canned<T>(envVar: string, fallback: T): T {
  const raw = process.env[envVar];
  return raw ? (JSON.parse(raw) as T) : fallback;
}

function handle(msg: any): void {
  const { id, method, params } = msg;
  if (process.env.NORMA_LSP_FAKE_DIE_ON && method === process.env.NORMA_LSP_FAKE_DIE_ON) {
    process.exit(1); // no response ever written — client must see this as a request-in-flight death
  }
  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: { capabilities: {}, serverInfo: { name: "fake-lsp", version: "1" } } });
      break;
    case "initialized":
    case "textDocument/didClose":
      break; // notifications, no reply
    case "textDocument/didOpen": {
      const openedUri = params?.textDocument?.uri;
      if (openedUri) openUris.add(openedUri);
      if (process.env.NORMA_LSP_FAKE_NO_DIAGNOSTICS === "1") break;
      const uri = params?.textDocument?.uri;
      const diagnostics = canned("NORMA_LSP_FAKE_DIAGS", [
        { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } }, severity: 1, message: "canned error", source: "fake-lsp" },
      ]);
      if (process.env.NORMA_LSP_FAKE_STAGED_DIAGS === "1") {
        // Real-tsserver shape: an (often empty) syntactic publish lands first, the semantic pass
        // follows as a SECOND publish for the same uri. The client must return the settled result.
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
        setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } }), 100);
      } else {
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
      }
      break;
    }
    case "textDocument/definition": {
      if (process.env.NORMA_LSP_FAKE_REQUIRE_OPEN === "1" && !openUris.has(params?.textDocument?.uri)) {
        send({ jsonrpc: "2.0", id, result: null }); break; // real servers: no answer for an unopened doc
      }
      const result = canned("NORMA_LSP_FAKE_DEFINITION", [
        { uri: "file:///workspace/def.ts", range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } },
      ]);
      const respMsg = { jsonrpc: "2.0", id, result };
      if (process.env.NORMA_LSP_FAKE_SPLIT === "1") { sendSplitBody(respMsg); }
      else if (process.env.NORMA_LSP_FAKE_MERGE === "1") { heldDefinitionFrame = frame(respMsg); /* hold; flushed with references below */ }
      else { send(respMsg); }
      break;
    }
    case "textDocument/references": {
      if (process.env.NORMA_LSP_FAKE_REQUIRE_OPEN === "1" && !openUris.has(params?.textDocument?.uri)) {
        send({ jsonrpc: "2.0", id, result: null }); break;
      }
      const result = canned("NORMA_LSP_FAKE_REFERENCES", [
        { uri: "file:///workspace/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        { uri: "file:///workspace/b.ts", range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
      ]);
      const respFrame = frame({ jsonrpc: "2.0", id, result });
      if (heldDefinitionFrame) {
        // ONE stdout write carrying two complete frames back-to-back — proves the client's
        // read loop dispatches every frame in a chunk, not just the first.
        process.stdout.write(Buffer.concat([heldDefinitionFrame, respFrame]));
        heldDefinitionFrame = null;
      } else {
        process.stdout.write(respFrame);
      }
      break;
    }
    case "shutdown":
      send({ jsonrpc: "2.0", id, result: null });
      break;
    case "exit":
      process.exit(0);
      break;
    default:
      if (typeof id !== "undefined" && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf: Buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buf.subarray(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.subarray(headerEnd + 4); continue; } // malformed header; resync defensively
    const length = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + length) return; // partial frame; wait for more data
    const body = buf.subarray(bodyStart, bodyStart + length).toString("utf8");
    buf = buf.subarray(bodyStart + length);
    let msg: any;
    try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});
