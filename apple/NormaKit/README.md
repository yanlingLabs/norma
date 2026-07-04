# NormaKit

Swift bridge to the norma-core daemon: unix-socket NDJSON JSON-RPC client, typed method
wrappers, `AsyncStream<NormaEvent>` events with reconnect + resync-from-lastSeq.

- Transport: `UnixSocketTransport` (NWConnection, `NWEndpoint.unix`); default socket
  `$NORMA_HOME/run/core.sock` (`~/.norma/run/core.sock`).
- Auth: harness role token from the Keychain (service `com.norma.core`, account
  `harness-token` — the same item the CLI reads). First read prompts once; "Always Allow".
- Transient events: `assistant_delta` is broadcast-only (never persisted/replayed) and is
  exempt from seq dedupe — its `seq` is the server's lastSeq at broadcast time.

## norma-probe

Build: `swift build` → `.build/debug/norma-probe`

    norma-probe list
    norma-probe create global --cwd /path/to/project
    norma-probe attach s_xxxx            # streams; deltas render token-by-token
    norma-probe send s_xxxx "hello"      # from a second terminal
    # --token <t> / --socket <path> override Keychain / default socket

Phase-2a live gate: `norma resume <id> "<prompt>"` in terminal A with `norma-probe attach <id>`
in terminal B — B shows deltas token-by-token BEFORE turn_completed; `norma-probe send` from B
appears in A's session. See docs/superpowers/specs/2026-07-04-phase-2-orb-harness-design.md §5.
