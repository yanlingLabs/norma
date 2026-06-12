import { join } from "node:path";
import { resolveNormaHome, KeychainSecretStore, startDaemon, TOKEN_NAMES } from "@norma/core";
import { NormaClient } from "./client";

const AQUA = "\x1b[38;2;53;214;232m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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
    const sessionId = target === "new" ? await c.createSession("global") : target;
    await c.attach(sessionId);
    await c.send(sessionId, text);
    console.log(`${AQUA}sent to ${sessionId}${RESET}`);
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
      process.stdout.write("Paste your OpenAI API key: ");
      const key = (await new Promise<string>((r) => process.stdin.once("data", (d) => r(String(d))))).trim();
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
  default:
    console.log(`norma (Phase 1a) — commands:
  daemon run | daemon install | daemon uninstall | daemon status
  ping | sessions | send <sessionId|new> <text> | watch <sessionId>
  login [--api-key] | logout | provider`);
}
