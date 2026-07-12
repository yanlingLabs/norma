import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { RoutineRunner } from "./scheduler";

/** The slice of AgentEngine's public surface runHeadless actually needs — a plain duck-typed
 *  interface (not `import type { AgentEngine } ...`) so this module's own unit tests can stub it
 *  with a few lines instead of standing up a real engine + provider + tool registry. daemon.ts
 *  passes its real AgentEngine instance straight through (it structurally satisfies this). */
export interface MinimalEngine {
  runTurn(sessionId: string): Promise<void>;
}

// Every rate-limit ProviderEvent (providers/openai-compatible.ts's mapHttpError, shared by both
// the openai-compatible and codex-oauth providers — see providers/quota.ts's withQuota) carries
// `code: "rate_limit"` and a message starting with this exact prefix. That `code` is NOT persisted
// on the `agent_error` SessionEvent (engine.ts only carries `message` through) — adding it would be
// a protocol/NormaKit-Swift ripple out of this task's scope (see routines/runner.ts's own report),
// so quota detection here is a documented, deliberately narrow string match on the one place that
// code is guaranteed to leave a fingerprint. If a provider's error message shape ever changes this
// silently stops detecting quota — a comment at both ends (here and mapHttpError) is the tripwire.
const QUOTA_ERROR_PREFIX = "HTTP 429";

/** Builds the RoutineRunner the daemon wires into makeRoutineScheduler — `runHeadless` reuses the
 *  SAME internal path `norma -p` drives (session create → post the prompt as a user_message → one
 *  engine.runTurn → read the final assistant text back off the session log), just in-process
 *  instead of over the IPC socket (the scheduler already lives inside the daemon).
 *
 *  Origin stamping (design doc §2/§3: "origin: routine/<id> stamped in session meta, visible in
 *  sessions list"): session meta has no free-form field yet — `origin` isn't part of
 *  SessionCreateParams or SessionStore's schema today, and adding one is genuine protocol surface
 *  (SessionCreateParams, the sqlite `sessions` table, SessionRow, meta()'s return shape) that
 *  belongs with T3's RPC work, not bundled into this scheduler task. This stamps `origin` as the
 *  session's TITLE instead, via a `session_titled` event appended immediately after creation — a
 *  documented fallback, not a new event/field. It satisfies the "visible in sessions list" intent
 *  (SessionStore.list()'s `title` column) at zero protocol cost, and titles.ts's SessionTitler
 *  never overwrites it (maybeTitle's very first check is `if (this.store.getTitle(sessionId))
 *  return`, and this stamp lands before the turn runs). If T3 later adds a real `origin` meta
 *  field, this title stamp can stay (or be demoted to a fallback-when-meta-absent) without a
 *  breaking change to any consumer of the title. */
export function makeDaemonRoutineRunner(deps: {
  store: SessionStore;
  hub: SessionHub;
  engine: MinimalEngine | null;
}): RoutineRunner {
  return {
    async runHeadless(opts): Promise<{ ok: boolean; quotaLimited?: boolean; resultText?: string; error?: string }> {
      if (!deps.engine) return { ok: false, error: "agent disabled: no provider configured" };

      const sessionId = deps.store.createSession("routine", { cwd: opts.cwd, approvalPolicy: opts.policy });
      deps.hub.append(sessionId, { type: "session_titled", sessionId, threadId: "main", title: opts.origin });
      deps.hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: opts.prompt, clientName: "routine" });

      try {
        await deps.engine.runTurn(sessionId);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const events = deps.store.read(sessionId);
      // Main-thread only — a routine prompt that itself spawns subagents surfaces their results
      // through the main thread's own assistant_message (spawn_agent's normal tool_result bridge),
      // exactly like a `norma -p` turn.
      const mainEvents = events.filter((e) => !("threadId" in e) || e.threadId === "main");
      const lastError = [...mainEvents].reverse().find((e) => e.type === "agent_error");
      if (lastError && lastError.type === "agent_error") {
        return {
          ok: false,
          error: lastError.message,
          ...(lastError.message.startsWith(QUOTA_ERROR_PREFIX) ? { quotaLimited: true } : {}),
        };
      }
      const lastAssistant = [...mainEvents].reverse().find((e) => e.type === "assistant_message");
      return { ok: true, resultText: lastAssistant && lastAssistant.type === "assistant_message" ? lastAssistant.text : "" };
    },
  };
}
