import type { SessionEvent } from "@norma/protocol";
import type { SessionStore, EventInput } from "./store";

export interface HubClient {
  clientName: string;
  deliver(event: SessionEvent): boolean;
}

export class SessionHub {
  private attachments = new Map<string, Set<HubClient>>(); // sessionId -> clients
  private byClient = new Map<HubClient, string>();         // client -> sessionId

  constructor(private readonly store: SessionStore) {}

  attach(client: HubClient, sessionId: string, fromSeq: number): number {
    // Defense-in-depth: a client can only be attached to one session — re-attach = move.
    const prev = this.byClient.get(client);
    if (prev && prev !== sessionId) this.detach(client);
    for (const e of this.store.read(sessionId, fromSeq)) client.deliver(e); // replay
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
    const dead: HubClient[] = [];
    for (const c of this.attachments.get(sessionId) ?? []) {
      let alive = false;
      try { alive = c.deliver(event); }
      catch { alive = false; } // a broken deliver (e.g. dead socket) must not poison the fan-out
      if (!alive) dead.push(c);
    }
    for (const c of dead) {
      this.attachments.get(sessionId)?.delete(c);
      this.byClient.delete(c);
      this.appendAndBroadcast(sessionId, {
        type: "harness_detached", sessionId, clientName: c.clientName,
      }); // bounded recursion: each level evicts at least one client
    }
    return event;
  }
}
