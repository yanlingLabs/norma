import type { SessionEvent } from "@norma/protocol";
import type { SessionStore, EventInput } from "./store";

export interface HubClient {
  clientName: string;
  deliver(event: SessionEvent): void;
}

export class SessionHub {
  private attachments = new Map<string, Set<HubClient>>(); // sessionId -> clients
  private byClient = new Map<HubClient, string>();         // client -> sessionId

  constructor(private readonly store: SessionStore) {}

  attach(client: HubClient, sessionId: string, fromSeq: number): number {
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

  private appendAndBroadcast(sessionId: string, input: EventInput): SessionEvent {
    const event = this.store.append(sessionId, input);
    for (const c of this.attachments.get(sessionId) ?? []) c.deliver(event);
    return event;
  }
}
