import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, SessionEvent,
  SessionCreateResult, SessionAttachResult, SessionSendResult, SessionListResult,
  SessionAddDirResult, SessionSetCwdResult, TrustDirResult,
  BgListResult, BgPeekResult, BgKillResult, BgKillAllResult,
  ConnWriter, type WritableSocket,
} from "@norma/protocol";

export interface ConnectOptions {
  socketPath: string;
  token: string;
  clientName: string;
  role?: "harness" | "admin";
  timeoutMs?: number;
  onEvent: (event: SessionEvent) => void;
}

export class NormaClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  private timeoutMs: number;

  private constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  static async connect(opts: ConnectOptions): Promise<NormaClient> {
    const client = new NormaClient(opts.timeoutMs ?? 5000);
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
              const parsed = SessionEvent.safeParse(msg.params);
              if (parsed.success) opts.onEvent(parsed.data);
              // unknown/future event types are skipped for forward-compat
            }
          }
        },
        drain() {
          client.writer.onDrain();
        },
        close() {
          for (const p of client.pending.values()) p.reject(new Error("connection closed"));
          client.pending.clear();
        },
        error() {}, // close() follows and rejects pending; stub silences Bun's default stderr print
      },
    });
    client.writer = new ConnWriter(client.socket as unknown as WritableSocket);
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
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validated(schema: { safeParse(v: unknown): any }, raw: unknown, method: string): any {
    const r = schema.safeParse(raw);
    if (!r.success) throw new Error(`invalid result from server for ${method}`);
    return r.data;
  }

  async createSession(scope: string, opts?: { cwd?: string; approvalPolicy?: "ask" | "auto" }): Promise<{ sessionId: string; trusted: boolean }> {
    const r = this.validated(SessionCreateResult, await this.request(METHODS.sessionCreate, { scope, ...opts }), METHODS.sessionCreate);
    return { sessionId: r.sessionId, trusted: r.trusted };
  }
  async trustDir(path: string): Promise<boolean> {
    return this.validated(TrustDirResult, await this.request(METHODS.trustDir, { path }), METHODS.trustDir).trusted;
  }
  async attach(sessionId: string, fromSeq = 0): Promise<number> {
    return this.validated(SessionAttachResult, await this.request(METHODS.sessionAttach, { sessionId, fromSeq }), METHODS.sessionAttach).lastSeq;
  }
  async send(sessionId: string, text: string): Promise<number> {
    return this.validated(SessionSendResult, await this.request(METHODS.sessionSend, { sessionId, text }), METHODS.sessionSend).seq;
  }
  async listSessions() {
    return this.validated(SessionListResult, await this.request(METHODS.sessionList), METHODS.sessionList);
  }
  async addDir(sessionId: string, path: string, persist = false): Promise<string[]> {
    return this.validated(SessionAddDirResult, await this.request(METHODS.sessionAddDir, { sessionId, path, persist }), METHODS.sessionAddDir).roots;
  }
  async setCwd(sessionId: string, cwd: string): Promise<string> {
    return this.validated(SessionSetCwdResult, await this.request(METHODS.sessionSetCwd, { sessionId, cwd }), METHODS.sessionSetCwd).cwd;
  }
  async bgList(sessionId: string): Promise<Array<{ taskId: string; command: string; status: string; exitCode: number | null; startedAt: number }>> {
    return this.validated(BgListResult, await this.request(METHODS.bgList, { sessionId }), METHODS.bgList).tasks;
  }
  async bgPeek(sessionId: string, taskId: string): Promise<{ chunk: string; status: string; exitCode: number | null }> {
    return this.validated(BgPeekResult, await this.request(METHODS.bgPeek, { sessionId, taskId }), METHODS.bgPeek);
  }
  async bgKill(sessionId: string, taskId: string): Promise<{ ok: true }> {
    return this.validated(BgKillResult, await this.request(METHODS.bgKill, { sessionId, taskId }), METHODS.bgKill);
  }
  async bgKillAll(sessionId: string): Promise<{ ok: true; killed: number }> {
    return this.validated(BgKillAllResult, await this.request(METHODS.bgKillAll, { sessionId }), METHODS.bgKillAll);
  }
  close(): void { this.socket.end(); }
}
