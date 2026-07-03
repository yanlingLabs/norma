import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveNormaHome, KeychainSecretStore, startDaemon, TOKEN_NAMES } from "@norma/core";
import { METHODS } from "@norma/protocol";
import { NormaClient } from "./client";
import { applyEvent, isStalled, type WatchdogState } from "./watchdog";

const AQUA = "\x1b[38;2;53;214;232m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  try {
    for await (const chunk of stdin) {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { process.stdout.write("\n"); return buf; }
        if (ch === "") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C
        if (ch === "" || ch === "\b") { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        buf += ch;
        process.stdout.write("*");
      }
    }
    return buf;
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  }
}

// Single y/N question on stdin, reusing the same non-raw "read a chunk, check for a leading y"
// pattern the approval_requested prompt below uses. TTY-guarded by callers; resolves false on EOF.
async function askYesNo(promptText: string): Promise<boolean> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    const onData = (d: Buffer) => { cleanup(); resolvePromise(String(d).trim().toLowerCase() === "y"); };
    const onEnd = () => { cleanup(); resolvePromise(false); };
    function cleanup() { stdin.off("data", onData); stdin.off("end", onEnd); }
    stdin.once("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

async function getToken(): Promise<string> {
  const t = await new KeychainSecretStore().get(TOKEN_NAMES.harness);
  if (!t) throw new Error("no harness token — is the daemon installed? run: norma daemon run");
  return t;
}

function socketPath(): string {
  return join(resolveNormaHome(), "run", "core.sock");
}

async function connect(name: string, onEvent: (e: any) => void = () => {}): Promise<NormaClient> {
  return NormaClient.connect({ socketPath: socketPath(), token: await getToken(), clientName: name, onEvent });
}

// Canned prompt for `norma init`: surveys the project and writes/updates a NORMA.md at its root.
export const INIT_PROMPT =
  "Survey this project to understand it: read the README, the package manifest (package.json/pyproject/Cargo.toml/etc.), and skim the directory structure and a few key source files. Then write a concise NORMA.md at the project root capturing: what this project is, how to build/test/run it, and the key conventions a new contributor should follow. If a NORMA.md already exists, read it and UPDATE it rather than clobbering. Keep it tight and factual.";

// Headless agent mode: `norma -p "<prompt>" [--auto]`. Streams the turn to stdout and,
// under the default "ask" approval policy, prompts on stdin for each tool approval.
// promptOverride/forceAuto let other commands (e.g. `init`) reuse the same headless flow
// with a canned prompt instead of reading argv. existingSessionId (set by `norma resume`)
// attaches to a previously-created session instead of creating a new one.
async function runHeadlessAgent(promptOverride?: string, forceAuto = false, existingSessionId?: string): Promise<void> {
  // -p teardown: mirrors Claude Code's headless grace-kill. Any bg tasks still running when the
  // turn completes get a grace period (NORMA_BG_PRINT_WAIT_MS, default 5000ms; 0 = poll until none
  // are running rather than racing a fixed timer) before we force-kill whatever remains.
  async function endHeadlessTurn(c: NormaClient, sessionId: string, wdTimer: ReturnType<typeof setInterval> | undefined, exitCode: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    if (wdTimer) clearInterval(wdTimer); // normal completion — stop watching for a stall that didn't happen
    const running = (await c.bgList(sessionId)).filter((t) => t.status === "running");
    if (running.length) {
      const waitMs = Number(process.env.NORMA_BG_PRINT_WAIT_MS ?? 5000);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        while ((await c.bgList(sessionId)).some((t) => t.status === "running")) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await c.bgKillAll(sessionId);
    }
    c.close();
    process.exit(exitCode);
  }
  const prompt = promptOverride ?? process.argv[3];
  if (!prompt) {
    console.error('usage: norma -p "<prompt>" [--auto]');
    process.exit(1);
  }
  const auto = forceAuto || process.argv.includes("--auto");
  const pending: string[] = []; // callIds awaiting a y/n on stdin, oldest first
  let sessionId = ""; // set below, before send() — turn_completed can only fire after that
  const wd: WatchdogState = { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: Date.now() };
  let wdTimer: ReturnType<typeof setInterval> | undefined; // started once the turn is sent; cleared on completion/stall
  let exiting = false; // guard to ensure a single exit path wins, not a race between stall watchdog and endHeadlessTurn

  const c = await connect("cli-p", (e) => {
    applyEvent(wd, e, Date.now());
    if (e.type === "assistant_message") console.log(`${AQUA}${e.text}${RESET}`);
    else if (e.type === "tool_call") console.log(`${DIM}⚙ ${e.name} ${e.argsJson.slice(0, 120)}${RESET}`);
    else if (e.type === "tool_result") console.log(`${DIM}  ↳ ${e.isError ? "ERROR: " : ""}${e.output.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}`);
    else if (e.type === "approval_requested") {
      process.stdout.write(`approve ${e.toolName}? ${DIM}${e.summary}${RESET} [y/N] `);
      pending.push(e.callId);
    } else if (e.type === "directory_added") console.log(`${DIM}+ dir ${e.path}${e.persisted ? " (remembered)" : ""}${RESET}`);
    else if (e.type === "bg_task_started") console.log(`${DIM}▶ bg ${e.taskId} started: ${e.command.slice(0, 80)}${RESET}`);
    else if (e.type === "bg_task_output") process.stdout.write(`${DIM}${e.chunk}${RESET}`);
    else if (e.type === "bg_task_exited") console.log(`${DIM}■ bg ${e.taskId} exited (${e.killed ? "killed" : "exit " + e.exitCode})${RESET}`);
    else if (e.type === "agent_error") {
      console.error(`agent error: ${e.message}`);
    } else if (e.type === "turn_completed") {
      void endHeadlessTurn(c, sessionId, wdTimer, e.stopReason === "end_turn" ? 0 : 1);
    }
  });

  const cwd = process.cwd();
  if (existingSessionId) {
    sessionId = existingSessionId;
    const info = (await c.listSessions()).sessions.find((r: any) => r.sessionId === existingSessionId);
    if (!info) { console.error(`no such session: ${existingSessionId}`); c.close(); process.exit(1); }
    console.log(`${DIM}↻ resuming ${existingSessionId} — ${info.scope}, ${info.lastSeq} events${RESET}`);
    // Attach from the tip (info.lastSeq), not seq 0: attaching from 0 would replay every
    // historical turn_completed event on this session, tripping endHeadlessTurn immediately.
    await c.attach(sessionId, info.lastSeq);
  } else {
    const created = await c.createSession("global", { cwd, approvalPolicy: auto ? "auto" : "ask" });
    sessionId = created.sessionId;
    if (!created.trusted) {
      const wantTrust = process.argv.includes("--trust")
        || (process.stdout.isTTY && !process.argv.includes("--no-trust") && (await askYesNo(`Do you trust the files in ${cwd}? Norma may grant directory access declared there. [y/N] `)));
      if (wantTrust) { await c.trustDir(cwd); console.log(`${DIM}trusted ${cwd}${RESET}`); }
    }
    await c.attach(sessionId);
  }

  if (!auto) {
    process.stdin.on("data", async (d) => {
      const yes = String(d).trim().toLowerCase() === "y";
      const callId = pending.shift();
      if (callId) await c.request(METHODS.approvalRespond, { sessionId, callId, approved: yes });
    });
  }

  await c.send(sessionId, prompt);

  // Stall watchdog: if the turn is running with nothing in flight (no tool executing, no
  // approval awaiting a human) and no event has landed for thresholdMs, assume the agent/turn
  // is wedged and abort rather than hang forever. Polled on a 5s tick against the pure
  // isStalled() check — see watchdog.ts for the (deterministically tested) logic.
  const thresholdMs = Number(process.env.NORMA_TURN_STALL_MS ?? 180000);
  wdTimer = setInterval(() => {
    if (isStalled(wd, Date.now(), thresholdMs)) {
      if (exiting) return;
      exiting = true;
      clearInterval(wdTimer);
      console.error(`\n[stalled: no progress for ${Math.round((Date.now() - wd.lastEventAt) / 1000)}s — aborting]`);
      void c.interrupt(sessionId).finally(() => process.exit(2));
    }
  }, 5000);
  wdTimer.unref?.(); // don't let the poll tick keep the process alive after normal completion

  await new Promise(() => {}); // exits via the turn_completed branch of onEvent above
}

// Guarded so `main.ts` can be imported (e.g. by tests, for INIT_PROMPT/runHeadlessAgent) without
// executing the CLI — import.meta.main is true only when this file is the entry point.
if (import.meta.main) {
  if (process.argv[2] === "-p") {
    await runHeadlessAgent(); // never resolves normally — exits via process.exit()
  }

  const argv = process.argv.slice(2);
  const [cmd, sub] = argv;

  // Two-word subcommands use "cmd sub"; single-word commands match on cmd alone.
  const cmdKey = cmd === "daemon" ? `daemon ${sub ?? ""}`.trim() : (cmd ?? "");

  switch (cmdKey) {
  case "daemon run": {
    await startDaemon();
    break; // keeps running; SIGINT/SIGTERM handled in daemon.ts
  }
  case "ping": {
    const c = await connect("cli-ping");
    console.log(`${AQUA}◍ norma-core is up${RESET} ${DIM}(${socketPath()})${RESET}`);
    c.close();
    break;
  }
  case "sessions": {
    const c = await connect("cli-sessions");
    const { sessions } = (await c.listSessions()) as any;
    for (const s of sessions) console.log(`${AQUA}${s.sessionId}${RESET} ${DIM}${s.scope} · ${s.lastSeq} events${RESET}`);
    c.close();
    break;
  }
  case "send": {
    // usage: norma send <sessionId|new> <text...>
    const args = process.argv.slice(3);
    const target = args[0];
    const text = args.slice(1).join(" ");
    if (!target || !text) { console.error("usage: norma send <sessionId|new> <text…>"); process.exit(1); }
    const c = await connect("cli-send");
    const sessionId = target === "new" ? (await c.createSession("global")).sessionId : target;
    await c.attach(sessionId);
    await c.send(sessionId, text);
    console.log(`${AQUA}sent to ${sessionId}${RESET}`);
    c.close();
    break;
  }
  case "add-dir": {
    const sessionId = process.argv[3];
    const path = process.argv[4];
    if (!sessionId || !path) { console.error("usage: norma add-dir <sessionId> <path> [--persist]"); process.exit(1); }
    const c = await connect("cli-add-dir");
    const roots = await c.addDir(sessionId, path, process.argv.includes("--persist"));
    console.log(`${AQUA}+ dir ${path} → ${roots.length} roots${RESET}`);
    c.close();
    break;
  }
  case "trust": {
    const arg = process.argv[3];
    if (arg === "--list") {
      // Protocol has no daemon.trustList method (kept minimal) — read ~/.norma/trust.json directly.
      const trustPath = join(resolveNormaHome(), "trust.json");
      let dirs: string[] = [];
      if (existsSync(trustPath)) {
        try {
          const raw = JSON.parse(readFileSync(trustPath, "utf8"));
          dirs = Array.isArray(raw?.trustedDirs) ? raw.trustedDirs.map(String) : [];
        } catch { /* corrupt/unreadable file — treat as empty */ }
      }
      if (dirs.length === 0) console.log("(none)");
      else for (const d of dirs) console.log(d);
    } else if (arg) {
      const c = await connect("cli-trust");
      await c.trustDir(resolve(arg));
      console.log(`${AQUA}trusted ${resolve(arg)}${RESET}`);
      c.close();
    } else {
      console.error("usage: norma trust <dir> | norma trust --list");
      process.exit(1);
    }
    break;
  }
  case "cd": {
    const sessionId = process.argv[3];
    const cwd = process.argv[4];
    if (!sessionId || !cwd) { console.error("usage: norma cd <sessionId> <path>"); process.exit(1); }
    const c = await connect("cli-cd");
    const newCwd = await c.setCwd(sessionId, cwd);
    console.log(`${AQUA}cwd → ${newCwd}${RESET}`);
    c.close();
    break;
  }
  case "steer": {
    const sessionId = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!sessionId || !text) { console.error("usage: norma steer <sessionId> <text…>"); process.exit(1); }
    const c = await connect("cli-steer");
    const result = await c.steer(sessionId, text);
    console.log(`${AQUA}steered${RESET} ${result.injected ? "(injected)" : "(queued for next turn)"}`);
    c.close();
    break;
  }
  case "interrupt": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma interrupt <sessionId>"); process.exit(1); }
    const c = await connect("cli-interrupt");
    const result = await c.interrupt(sessionId);
    console.log(`${AQUA}interrupted${RESET} ${result.wasRunning ? "(was running)" : "(nothing running)"}`);
    c.close();
    break;
  }
  case "bg": {
    const bgSub = process.argv[3];
    const bgSessionId = process.argv[4];
    const bgTaskId = process.argv[5];
    if (!bgSessionId || (bgSub !== "list" && !bgTaskId)) {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      process.exit(1);
    }
    const c = await connect("cli-bg");
    if (bgSub === "list") {
      const tasks = await c.bgList(bgSessionId);
      for (const t of tasks) console.log(`${AQUA}${t.taskId}${RESET} ${DIM}${t.status} · ${t.command.slice(0, 80)}${RESET}`);
      if (tasks.length === 0) console.log(`${DIM}(no bg tasks)${RESET}`);
    } else if (bgSub === "peek") {
      const r = await c.bgPeek(bgSessionId, bgTaskId!);
      console.log(`${AQUA}${r.status}${RESET} ${DIM}exit=${r.exitCode ?? "-"}${RESET}`);
      if (r.chunk) process.stdout.write(r.chunk);
    } else if (bgSub === "kill") {
      await c.bgKill(bgSessionId, bgTaskId!);
      console.log(`${AQUA}killed ${bgTaskId}${RESET}`);
    } else {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      c.close();
      process.exit(1);
    }
    c.close();
    break;
  }
  case "watch": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma watch <sessionId>"); process.exit(1); }
    const c = await connect("cli-watch", (e) => {
      if (e.type === "user_message") console.log(`${AQUA}❯${RESET} [${e.clientName}] ${e.text}`);
      else console.log(`${DIM}· ${e.type}${"clientName" in e ? ` (${e.clientName})` : ""}${RESET}`);
    });
    await c.attach(sessionId, 0);
    console.log(`${DIM}watching ${sessionId} — ctrl-c to stop${RESET}`);
    await new Promise(() => {}); // run until interrupted
    break; // unreachable, but keeps the switch uniform
  }
  case "daemon install": {
    const { installDaemon } = await import("./launchd");
    // process.execPath = the bun binary in dev, the compiled `norma` binary in production.
    const binary = process.execPath;
    if (binary.endsWith("/bun")) {
      console.error("daemon install requires the compiled norma binary (Task 16); in dev use: norma daemon run");
      process.exit(1);
    }
    await installDaemon(binary, resolveNormaHome());
    console.log(`${AQUA}installed launchd agent${RESET} — daemon starts at login and stays alive`);
    break;
  }
  case "daemon uninstall": {
    const { uninstallDaemon } = await import("./launchd");
    await uninstallDaemon();
    console.log("launchd agent removed");
    break;
  }
  case "daemon status": {
    const { daemonStatus } = await import("./launchd");
    console.log(await daemonStatus());
    break;
  }
  case "login": {
    const { KeychainSecretStore, CodexAuthStore, runLoginFlow, CODEX, OPENAI_API_KEY_SECRET } = await import("@norma/core");
    const secrets = new KeychainSecretStore();
    if (process.argv.includes("--api-key")) {
      const key = (await readSecret("Paste your OpenAI API key: ")).trim();
      if (!key.startsWith("sk-")) { console.error("that does not look like an API key"); process.exit(1); }
      await secrets.set(OPENAI_API_KEY_SECRET, key);
      console.log(`${AQUA}API key stored in Keychain${RESET} — set provider type in ~/.norma/settings.json (openai-compatible)`);
      break;
    }
    const tokens = await runLoginFlow({
      clientId: CODEX.clientId,
      authorizeUrl: CODEX.authorizeUrl,
      tokenUrl: CODEX.tokenUrl,
      callbackPort: CODEX.callbackPort,
      scope: CODEX.scope,
      openBrowser: async (url) => { Bun.spawn(["open", url]); },
    });
    await new CodexAuthStore(secrets).save(tokens);
    console.log(`${AQUA}◍ signed in with ChatGPT${RESET} ${DIM}(account ${tokens.accountId ?? "unknown"})${RESET}`);
    break;
  }
  case "logout": {
    const { KeychainSecretStore, CODEX_SECRET_NAMES } = await import("@norma/core");
    const secrets = new KeychainSecretStore();
    // Phase 1a simplification: SecretStore gains delete() in 1b — empty value de-authorizes everywhere today.
    for (const name of Object.values(CODEX_SECRET_NAMES)) {
      await secrets.set(name, "");
    }
    console.log("signed out");
    break;
  }
  case "provider": {
    const { loadSettings, resolveNormaHome } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    console.log(`${AQUA}${s.provider.type}${RESET} ${DIM}model ${s.provider.model}${RESET}`);
    break;
  }
  case "init": {
    await runHeadlessAgent(INIT_PROMPT, true); // force auto: writes NORMA.md without approval prompts
    break;
  }
  case "resume": {
    const sid = process.argv[3];
    if (!sid) { // picker: list resumable sessions
      const c = await connect("cli-resume");
      const rows = (await c.listSessions()).sessions;
      if (!rows.length) console.log("no sessions yet");
      for (const r of rows) console.log(`${r.sessionId}  ${DIM}${r.scope}  ${r.lastSeq} events${RESET}`);
      c.close(); process.exit(0);
    }
    const text = process.argv.slice(4).join(" ");
    if (!text) { // recap only: show the session line, tell them how to continue
      const c = await connect("cli-resume");
      const info = (await c.listSessions()).sessions.find((r: any) => r.sessionId === sid);
      console.log(info ? `${sid}  ${DIM}${info.scope}  ${info.lastSeq} events${RESET}\nresume with: norma resume ${sid} "<message>"` : `no such session: ${sid}`);
      c.close(); process.exit(info ? 0 : 1);
    }
    await runHeadlessAgent(text, true, sid); // continue the existing session headless (auto)
    break;
  }
  case "provider-smoke": {
    const { loadSettings, resolveNormaHome, createProvider, KeychainSecretStore } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    const active = await createProvider(s, new KeychainSecretStore());
    const promptIdx = process.argv.indexOf("--prompt");
    const prompt = promptIdx > 0 ? process.argv[promptIdx + 1]! : "Reply with exactly: norma provider smoke OK";
    console.log(`${DIM}provider=${active.provider.id} model=${active.model}${RESET}`);
    let text = "";
    for await (const e of active.provider.streamTurn({
      model: active.model,
      input: [{ type: "message", role: "user", content: prompt }],
    })) {
      if (e.type === "text_delta") { text += e.delta; process.stdout.write(e.delta); }
      else if (e.type === "error") { console.error(`\n${e.code}: ${e.message}`); process.exit(1); }
      else if (e.type === "usage") console.log(`\n${DIM}usage: ${e.inputTokens} in / ${e.outputTokens} out${RESET}`);
    }
    process.exit(text.length > 0 ? 0 : 1);
  }
  default:
    console.log(`norma (Phase 1b-ii-d) — commands:
  daemon run | daemon install | daemon uninstall | daemon status
  ping | sessions | send <sessionId|new> <text> | watch <sessionId> | add-dir <sessionId> <path> [--persist] | cd <sessionId> <path>
  steer <sessionId> <text> | interrupt <sessionId>
  resume [id] [msg]   list sessions, or continue an existing one
  trust <dir> [--list]
  bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>
  login [--api-key] | logout | provider | provider-smoke [--prompt <text>]
  init                                            generate/update NORMA.md by surveying the project
  -p "<prompt>" [--auto] [--trust|--no-trust]   headless agent turn (asks for tool approval unless --auto)`);
  }
}
