import type { ModelInfo } from "./types";

/**
 * Codex OAuth parity constants — MUST track codex-rs (spec §4.5).
 * Provenance + reconciliation: docs/superpowers/research/2026-06-12-codex-parity.md
 *
 * Source: github.com/openai/codex @ 216dee1189fd589ea6c0741a5f92f578a3ca4640 (2026-06-12)
 *   - codex-rs/login/src/auth/manager.rs    → CLIENT_ID, backendUrl, tokenUrl
 *   - codex-rs/login/src/server.rs          → authorizeUrl, callbackPort, scope
 *   - codex-rs/login/src/auth/default_client.rs → originator (DEFAULT_ORIGINATOR)
 *   - codex-rs/core/src/client.rs           → OpenAI-Beta header key
 */
export const CODEX = {
  /** Hydra / Auth0 OAuth application id — shared by all Codex CLI clients. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",

  /** Authorization endpoint: {issuer}/oauth/authorize */
  authorizeUrl: "https://auth.openai.com/oauth/authorize",

  /** Token exchange + refresh endpoint */
  tokenUrl: "https://auth.openai.com/oauth/token",

  /** Local callback server port (primary; fallback 1457 per codex-rs allow-list) */
  callbackPort: 1455,

  /**
   * OAuth scopes — codex-rs scope string from build_authorize_url (server.rs).
   * Drift vs v1: codex-rs added `api.connectors.read api.connectors.invoke`.
   */
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",

  /**
   * Base URL for ChatGPT Codex backend (append /responses for the responses endpoint).
   * Canonical: CHATGPT_CODEX_BASE_URL in model-provider-info/src/lib.rs
   */
  backendUrl: "https://chatgpt.com/backend-api/codex",

  headers: {
    /**
     * OpenAI-Beta header value for HTTP responses requests.
     * v1 value: "responses=experimental".
     * codex-rs HTTP path has no static default (websocket uses "responses_websockets=2026-02-06").
     * TODO-verify: confirm this header is still required/accepted at next codex-rs release.
     */
    "OpenAI-Beta": "responses=experimental",

    /**
     * Originator header — identifies the client to the ChatGPT backend.
     * codex-rs DEFAULT_ORIGINATOR = "codex_cli_rs" (default_client.rs).
     * Drift vs v1: v1 sent "norma"; codex-rs value chosen for fingerprint parity (spec §4.5).
     * Note: codex-rs `is_first_party_originator` explicitly recognises "codex_cli_rs".
     */
    originator: "codex_cli_rs",
  } as Record<string, string>,
} as const;

/**
 * Static Codex model list — verified live 2026-07-10 from /models?client_version=1.0.0.
 *
 * The backend returns only these slugs for ChatGPT-account auth (OAuth).
 * The v1 static list (gpt-5.2-codex, gpt-5.1-codex, etc.) was stale; those models
 * return HTTP 400 "not supported when using Codex with a ChatGPT account."
 *
 * Live fetch response slugs: gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna (372K ctx, new since
 * 2026-06-13), gpt-5.5 / gpt-5.4 / gpt-5.4-mini (272K ctx — gpt-5.4 was previously wrongly
 * recorded as 128_000, which made auto-compaction fire ~2x early), and codex-auto-review
 * (hidden — excluded from this list, not offered as a user-selectable model).
 * Context windows and vision flags from /models payload field values.
 * codex-rs fetches models dynamically; this list is the best available static set.
 * TODO-verify: add a live /models fetch path to keep this current.
 */
export const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 372_000, supportsVision: true },
  { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 372_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 372_000, supportsVision: true },
  { id: "gpt-5.5", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.4", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.4-mini", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];
