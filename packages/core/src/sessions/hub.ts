import { SessionEvent } from "@norma/protocol";
import type { SessionStore, EventInput } from "./store";

export interface HubClient {
  clientName: string;
  deliver(event: SessionEvent): boolean;
}

export class SessionHub {
  private attachments = new Map<string, Set<HubClient>>(); // sessionId -> clients
  private byClient = new Map<HubClient, string>();         // client -> sessionId

  // Set by the IPC server (Task 3): a narrow, additional broadcast path for event types that must
  // reach EVERY authed harness, not just clients attached to the session in question (mirrors the
  // session_created broadcast the server already does for its own reasons). session_titled is the
  // first (only) such type — a harness viewing the session list needs a session it isn't attached
  // to to pick up its title live.
  onGlobalEvent?: (event: SessionEvent) => void;

  constructor(private readonly store: SessionStore) {}

  attach(client: HubClient, sessionId: string, fromSeq: number): number {
    // Defense-in-depth: a client can only be attached to one session — re-attach = move.
    const prev = this.byClient.get(client);
    if (prev && prev !== sessionId) this.detach(client);
    let lastSeq = fromSeq;
    for (const e of this.store.read(sessionId, fromSeq)) {
      // A client that dies mid-replay (e.g. a slow-consumer backlog cap trips) was never
      // really attached — don't add it, don't announce it. Return the seq of the last event
      // it successfully received so the caller still gets a coherent, non-sentinel lastSeq.
      if (!client.deliver(e)) return lastSeq;
      lastSeq = e.seq;
    }
    let set = this.attachments.get(sessionId);
    if (!set) { set = new Set(); this.attachments.set(sessionId, set); }
    set.add(client);
    this.byClient.set(client, sessionId);
    const e = this.appendAndBroadcast(sessionId, {
      type: "harness_attached", sessionId, clientName: client.clientName,
    });
    return e.seq;
  }

  detach(client: HubClient): void {
    const sessionId = this.byClient.get(client);
    if (!sessionId) return;
    this.attachments.get(sessionId)?.delete(client);
    this.byClient.delete(client);
    this.appendAndBroadcast(sessionId, {
      type: "harness_detached", sessionId, clientName: client.clientName,
    });
  }

  send(client: HubClient, sessionId: string, text: string): number {
    if (this.byClient.get(client) !== sessionId) {
      throw new Error(`client ${client.clientName} not attached to ${sessionId}`);
    }
    return this.appendAndBroadcast(sessionId, {
      type: "user_message", sessionId, threadId: "main", text, clientName: client.clientName,
    }).seq;
  }

  /** Append an event and broadcast it — for server-side producers (agent engine). */
  append(sessionId: string, input: EventInput): SessionEvent {
    return this.appendAndBroadcast(sessionId, input);
  }

  private appendAndBroadcast(sessionId: string, input: EventInput): SessionEvent {
    const event = this.store.append(sessionId, input);
    this.fanOut(sessionId, event);
    // Narrow on purpose: session_created already has its own server-side broadcast, and every
    // other event type is scoped to a session's own attachments.
    if (event.type === "session_titled") this.onGlobalEvent?.(event);
    return event;
  }

  /** Broadcast-only TRANSIENT event: fanned out to attached clients, NEVER persisted — absent
   *  from the JSONL log and from attach replay. Stamped with seq = the store's CURRENT lastSeq
   *  (it is not itself sequenced): monotonic-safe for naive lastSeq tracking, but clients must
   *  exempt transient events from seq-based dedupe. Used for assistant_delta streaming. */
  broadcastTransient(sessionId: string, input: EventInput): SessionEvent {
    const event = SessionEvent.parse({ ...input, seq: this.store.lastSeq(sessionId), ts: Date.now() });
    this.fanOut(sessionId, event);
    return event;
  }

  private fanOut(sessionId: string, event: SessionEvent): void {
    const dead: HubClient[] = [];
    for (const c of this.attachments.get(sessionId) ?? []) {
      let alive = false;
      try { alive = c.deliver(event); }
      catch { alive = false; } // a broken deliver (e.g. dead socket) must not poison the fan-out
      if (!alive) dead.push(c);
    }
    for (const c of dead) {
      // May already be gone if a nested broadcast (triggered by this same drain) evicted it —
      // e.g. two clients die in the same round; the first eviction's recursive harness_detached
      // fan-out can itself find the second dead and evict it. Without this guard the outer loop
      // would then process the second client again, double-evicting/double-announcing it.
      const set = this.attachments.get(sessionId);
      if (!set?.has(c)) continue;
      set.delete(c);
      this.byClient.delete(c);
      this.appendAndBroadcast(sessionId, {
        type: "harness_detached", sessionId, clientName: c.clientName,
      }); // bounded recursion: each level evicts at least one client
    }
  }
}
