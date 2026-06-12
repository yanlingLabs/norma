import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NormaDirs {
  home: string;
  sessionsDir: string;
  runDir: string;
  logsDir: string;
  socketPath: string;
  lockPath: string;
  settingsPath: string;
}

export function resolveNormaHome(): string {
  return process.env.NORMA_HOME ?? join(homedir(), ".norma");
}

const SUBDIRS = ["sessions", "memory", "skills/self", "agents", "plugins", "hooks", "logs", "run"];

export function bootstrapNormaDir(home: string = resolveNormaHome()): NormaDirs {
  for (const d of SUBDIRS) mkdirSync(join(home, d), { recursive: true });
  chmodSync(join(home, "run"), 0o700);

  const settingsPath = join(home, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + "\n");
  }

  return {
    home,
    sessionsDir: join(home, "sessions"),
    runDir: join(home, "run"),
    logsDir: join(home, "logs"),
    socketPath: join(home, "run", "core.sock"),
    lockPath: join(home, "run", "core.lock"),
    settingsPath,
  };
}
