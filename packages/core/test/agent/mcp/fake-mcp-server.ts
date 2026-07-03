// Minimal MCP stdio server for tests: initialize / notifications/initialized / tools/list (echo) / tools/call (echoes msg).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function send(o: unknown) { process.stdout.write(JSON.stringify(o) + "\n"); }
function handle(msg: any) {
  if (msg.method === "initialize") {
    if (process.env.NORMA_FAKE_NULL === "1") process.stdout.write("null\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  }
  else if (msg.method === "notifications/initialized") { /* notification, no reply */ }
  else if (msg.method === "tools/list") {
    const echoTool = { name: "echo", description: "Echo the msg back", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } };
    const tools = process.env.NORMA_FAKE_DUP === "1" ? [echoTool, echoTool] : [echoTool];
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.msg ?? ""}` }] } });
  else if (typeof msg.id === "number") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
