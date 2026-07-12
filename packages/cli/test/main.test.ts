import { describe, expect, test } from "bun:test";
import { formatResumeHint, routeCliInvocation, type CliRoute } from "../src/main";

// Pure arg-routing table test (final-review Findings 3+4). `routeCliInvocation` is the ONLY piece
// of the bare/--auto/--plan/-p/resume dispatch that's cheaply unit-testable without a real
// terminal/socket — everything downstream (actually entering chat, seeding policy via
// process.argv, resuming a session over the wire) is integration behavior exercised by hand /
// documented in the fix report, not here. `argv` throughout is the USER-supplied args
// (process.argv.slice(2)), matching what main.ts passes.

describe("routeCliInvocation — bare / policy-flag entry (Findings 3 & 4)", () => {
  test("bare `norma` on a TTY → chat, no existing session", () => {
    expect(routeCliInvocation([], true)).toEqual<CliRoute>({ kind: "chat" });
  });

  test("bare `norma --auto` / `--plan` on a TTY → chat (Finding 3 — previously fell through to help)", () => {
    expect(routeCliInvocation(["--auto"], true)).toEqual<CliRoute>({ kind: "chat" });
    expect(routeCliInvocation(["--plan"], true)).toEqual<CliRoute>({ kind: "chat" });
  });

  test("non-TTY bare `norma` → fallthrough, NOT chat (Finding 4 — keeps the usage/help output on scripted stdin)", () => {
    expect(routeCliInvocation([], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("non-TTY `norma --auto` / `--plan` → fallthrough too (chat requires a TTY regardless of which flag asked for it)", () => {
    expect(routeCliInvocation(["--auto"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["--plan"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });
});

describe("routeCliInvocation — `-p` and other subcommands are untouched", () => {
  test("`-p \"<prompt>\"` → fallthrough (handled by its own dedicated top-level check, not this table)", () => {
    expect(routeCliInvocation(["-p", "do the thing"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["-p", "do the thing"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("ordinary subcommands (ping, daemon run, …) → fallthrough, unaffected by this routing", () => {
    expect(routeCliInvocation(["ping"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["daemon", "run"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["sessions"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
  });
});

describe("routeCliInvocation — resume (Finding 3)", () => {
  test("`resume` with no id → fallthrough (the existing picker handles it)", () => {
    expect(routeCliInvocation(["resume"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("`resume <id>` with no message → chat on that session", () => {
    expect(routeCliInvocation(["resume", "sess1"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });

  test("`resume <id> --auto` / `--plan` (exactly the flag, nothing else) → chat, NOT a literal prompt", () => {
    expect(routeCliInvocation(["resume", "sess1", "--auto"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
    expect(routeCliInvocation(["resume", "sess1", "--plan"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });

  test("`resume <id> <text…>` → resumeOneShot, carrying the joined text (existing behavior, unchanged)", () => {
    expect(routeCliInvocation(["resume", "sess1", "hello", "world"], true)).toEqual<CliRoute>({
      kind: "resumeOneShot",
      sessionId: "sess1",
      text: "hello world",
    });
  });

  test("a flag FOLLOWED BY more text is real prompt text, not the chat-seed case ('anything else unchanged')", () => {
    expect(routeCliInvocation(["resume", "sess1", "--auto", "and then some"], true)).toEqual<CliRoute>({
      kind: "resumeOneShot",
      sessionId: "sess1",
      text: "--auto and then some",
    });
  });

  test("resume chat-entry is NOT gated on isTTY (pre-existing, unflagged behavior — documented, not changed here)", () => {
    expect(routeCliInvocation(["resume", "sess1"], false)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
    expect(routeCliInvocation(["resume", "sess1", "--auto"], false)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });
});

describe("formatResumeHint (Phase 3c Task 5 — the dim post-exit resume hint)", () => {
  test("exact text (dim-wrapped), including the session id", () => {
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    expect(formatResumeHint("s_abc123")).toBe(`${DIM}\nResume this session with:\n  norma resume s_abc123\n${RESET}`);
  });

  test("no trailing newline is added beyond the one already in the spec string (process.stdout.write, not console.log)", () => {
    const hint = formatResumeHint("x");
    expect(hint.endsWith("\n\x1b[0m")).toBe(true); // ends with the required "\n" then the RESET code — no EXTRA "\n"
  });
});
