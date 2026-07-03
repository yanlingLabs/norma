import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustStore } from "./trust";

export const BASE_PROMPT = [
  "You are Norma, an agentic assistant running on the user's Mac.",
  "You operate inside a session working directory; file tool paths are relative to it.",
  "Use the tools to accomplish the user's request, then reply with a concise summary.",
].join(" ");

const TRUNC = "\n[…truncated]";

/** Cap a string to `maxBytes` UTF-8 bytes, truncating on a valid boundary (a split multibyte char degrades to U+FFFD, never a lone surrogate). */
function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Read a UTF-8 file, capping at `maxBytes`; returns null if missing/unreadable/not a regular file. */
function readCapped(path: string, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const s = readFileSync(path, "utf8");
    if (s.length === 0) return null;
    const { text, truncated } = capBytes(s, maxBytes);
    return truncated ? text + TRUNC : text;
  } catch { return null; }
}

/** Read a file capped at `maxLines` AND `maxBytes` (whichever first). null if missing/unreadable/empty. */
function readMemory(path: string, maxLines: number, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    let s = readFileSync(path, "utf8");
    if (s.length === 0) return null;
    let truncated = false;
    const lines = s.split("\n");
    if (lines.length > maxLines) { s = lines.slice(0, maxLines).join("\n"); truncated = true; }
    const capped = capBytes(s, maxBytes);
    s = capped.text;
    truncated = truncated || capped.truncated;
    return truncated ? s + TRUNC : s;
  } catch { return null; }
}

export interface AssemblerCaps { instructionsBytes?: number; memoryLines?: number; memoryBytes?: number }

export class ContextAssembler {
  private readonly normaHome: string;
  private readonly trust: TrustStore;
  private readonly basePrompt: string;
  private readonly caps: Required<AssemblerCaps>;
  constructor(deps: { normaHome: string; trust: TrustStore; basePrompt?: string; caps?: AssemblerCaps }) {
    this.normaHome = deps.normaHome;
    this.trust = deps.trust;
    this.basePrompt = deps.basePrompt ?? BASE_PROMPT;
    this.caps = {
      instructionsBytes: deps.caps?.instructionsBytes ?? 32768,
      memoryLines: deps.caps?.memoryLines ?? 200,
      memoryBytes: deps.caps?.memoryBytes ?? 24576,
    };
  }

  assemble(input: { cwd: string | null }): string {
    const cwd = input.cwd;
    const trusted = cwd ? this.trust.isTrusted(cwd) : false;
    const sections: string[] = [this.basePrompt];

    const userInstr = readCapped(join(this.normaHome, "NORMA.md"), this.caps.instructionsBytes);
    if (userInstr) sections.push(`## User instructions (~/.norma/NORMA.md)\n${userInstr}`);

    if (cwd && trusted) {
      const projInstr = readCapped(join(cwd, "NORMA.md"), this.caps.instructionsBytes);
      if (projInstr) sections.push(`## Project instructions (NORMA.md)\n${projInstr}`);
    }

    const mem: string[] = [];
    const userMem = readMemory(join(this.normaHome, "memory", "MEMORY.md"), this.caps.memoryLines, this.caps.memoryBytes);
    if (userMem) mem.push(`### User memory\n${userMem}`);
    if (cwd && trusted) {
      const projMem = readMemory(join(cwd, ".norma", "memory", "MEMORY.md"), this.caps.memoryLines, this.caps.memoryBytes);
      if (projMem) mem.push(`### Project memory\n${projMem}`);
    }
    if (mem.length) sections.push(`## Memory\n${mem.join("\n\n")}`);

    // Capability seam — 1c-iii (skills) / 1c-iv (MCP) populate this. Stub for now.
    sections.push("## Available capabilities\nNo additional skills or MCP tools are loaded.");

    return sections.join("\n\n");
  }
}
