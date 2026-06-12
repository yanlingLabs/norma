import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, SessionEvent,
} from "@norma/protocol";

export interface ConnectOptions {
  socketPath: string;
  token: string;
  clientName: string;
  role?: "harness" | "admin";
  onEvent: (event: SessionEvent) => void;
}

export class NormaClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;

  static async connect(opts: ConnectOptions): Promise<NormaClient> {
    const client = new NormaClient();
    client.socket = await Bun.connect({
      unix: opts.socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of client.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null && client.pending.has(msg.id)) {
              const p = client.pending.get(msg.id)!;
              client.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
              else p.resolve(msg.result);
            } else if (msg.method === METHODS.event) {
              opts.onEvent(SessionEvent.parse(msg.params));
            }
          }
        },
        close() {
          for (const p of client.pending.values()) p.reject(new Error("connection closed"));
          client.pending.clear();
        },
      },
    });
    await client.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION,
      role: opts.role ?? "harness",
      token: opts.token,
      clientName: opts.clientName,
    });
    return client;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async createSession(scope: string): Promise<string> {
    return (await this.request(METHODS.sessionCreate, { scope })).sessionId;
  }
  async attach(sessionId: string, fromSeq = 0): Promise<number> {
    return (await this.request(METHODS.sessionAttach, { sessionId, fromSeq })).lastSeq;
  }
  async send(sessionId: string, text: string): Promise<number> {
    return (await this.request(METHODS.sessionSend, { sessionId, text })).seq;
  }
  async listSessions(): Promise<unknown> {
    return this.request(METHODS.sessionList);
  }
  close(): void { this.socket.end(); }
}
