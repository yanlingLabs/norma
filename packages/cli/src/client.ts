import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, SessionEvent,
  SessionCreateResult, SessionAttachResult, SessionSendResult, SessionListResult,
  SessionAddDirResult, SessionSetCwdResult, TrustDirResult,
  BgListResult, BgPeekResult, BgKillResult, BgKillAllResult,
  SessionSteerResult, SessionInterruptResult, SessionCompactResult, SkillsListResult,
  PluginsListResult, AskUserRespondResult, TaskListResult, ThreadListResult,
  PlanRespondResult, SessionSetPolicyResult, type ApprovalPolicy,
  DaemonStatusResult, QuotaStateResult, TrustListResult, TrustRemoveResult,
  PluginRevokeTokenResult,
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

  async createSession(scope: string, opts?: { cwd?: string; approvalPolicy?: ApprovalPolicy }): Promise<{ sessionId: string; trusted: boolean }> {
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
  async steer(sessionId: string, text: string): Promise<{ injected: boolean }> {
    const r = this.validated(SessionSteerResult, await this.request(METHODS.sessionSteer, { sessionId, text }), METHODS.sessionSteer);
    return { injected: r.injected };
  }
  async interrupt(sessionId: string): Promise<{ wasRunning: boolean }> {
    const r = this.validated(SessionInterruptResult, await this.request(METHODS.sessionInterrupt, { sessionId }), METHODS.sessionInterrupt);
    return { wasRunning: r.wasRunning };
  }
  async compact(sessionId: string): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    const r = this.validated(SessionCompactResult, await this.request(METHODS.sessionCompact, { sessionId }), METHODS.sessionCompact);
    return { compacted: r.compacted, uptoSeq: r.uptoSeq, summaryChars: r.summaryChars };
  }
  async listSkills(cwd?: string): Promise<Array<{ name: string; description: string; source: string; path: string }>> {
    return this.validated(SkillsListResult, await this.request(METHODS.skillsList, { cwd }), METHODS.skillsList).skills;
  }
  async listMcp(cwd?: string): Promise<Array<{ name: string; status: string; toolNames: string[]; source: string }>> {
    const r = await this.request(METHODS.mcpList, { cwd });
    return r.servers;
  }
  async pluginsList(): Promise<{
    ok: true;
    plugins: Array<{
      name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean;
      // Phase 4a Task 3 — consent-flow display data (all optional: older servers may omit them).
      tier?: "capability" | "platform"; requiredConsents?: string[]; consented?: string[]; legacy?: boolean;
      execPayload?: string[]; tccPermissions?: string[]; hardwarePermissions?: string[];
    }>;
  }> {
    return this.validated(PluginsListResult, await this.request(METHODS.pluginsList, {}), METHODS.pluginsList);
  }
  async askUserRespond(params: { sessionId: string; callId: string; answers: Record<string, string> }): Promise<{ ok: true; alreadyResolved: boolean }> {
    return this.validated(AskUserRespondResult, await this.request(METHODS.askUserRespond, params), METHODS.askUserRespond);
  }
  async taskList(params: { sessionId: string }): Promise<{ ok: true; tasks: Array<{ id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> }> {
    return this.validated(TaskListResult, await this.request(METHODS.taskList, params), METHODS.taskList);
  }
  async threadList(params: { sessionId: string }): Promise<{ ok: true; threads: Array<{ threadId: string; parentThreadId?: string; agentType?: string; status: "running" | "completed"; stopReason?: string }> }> {
    return this.validated(ThreadListResult, await this.request(METHODS.threadList, params), METHODS.threadList);
  }
  async planRespond(params: { sessionId: string; callId: string; approved: boolean; autoAccept?: boolean; feedback?: string }): Promise<{ ok: true; alreadyResolved: boolean }> {
    return this.validated(PlanRespondResult, await this.request(METHODS.planRespond, params), METHODS.planRespond);
  }
  async sessionSetPolicy(params: { sessionId: string; policy: ApprovalPolicy }): Promise<{ ok: true }> {
    return this.validated(SessionSetPolicyResult, await this.request(METHODS.sessionSetPolicy, params), METHODS.sessionSetPolicy);
  }
  /** Interactive-chrome convenience wrapper (2e-iii-b Task 6): the mode bar's shift+tab cycle
   *  calls this. Thin positional-arg alias over `sessionSetPolicy` (same `session.setPolicy` RPC). */
  async setPolicy(sessionId: string, policy: ApprovalPolicy): Promise<void> {
    await this.sessionSetPolicy({ sessionId, policy });
  }
  /** Dashboard read methods (Phase 2f Task 6 — CLI riders over Task 3's new methods). */
  async daemonStatus(): Promise<{
    version: string; uptimeMs: number; socketPath: string;
    provider: { id: string; model: string } | null; sessionsCount: number; pluginsCount: number;
  }> {
    return this.validated(DaemonStatusResult, await this.request(METHODS.daemonStatus, {}), METHODS.daemonStatus);
  }
  async quotaState(): Promise<{ kind: "ok" | "limited"; resumeAt?: number; inputTokens: number; outputTokens: number }> {
    return this.validated(QuotaStateResult, await this.request(METHODS.quotaState, {}), METHODS.quotaState);
  }
  async trustList(): Promise<string[]> {
    return this.validated(TrustListResult, await this.request(METHODS.trustList, {}), METHODS.trustList).dirs;
  }
  async trustRemove(path: string): Promise<boolean> {
    return this.validated(TrustRemoveResult, await this.request(METHODS.trustRemove, { path }), METHODS.trustRemove).removed;
  }
  /** Phase 4b Task 2: `plugin_tokens` lives in the daemon's sqlite, not settings.json — the CLI
   *  never opens that database directly (locking risk), so disable/remove revoke via this
   *  harness-role RPC instead (mint stays daemon-side, Task 3). */
  async pluginRevokeToken(pluginId: string): Promise<{ ok: true }> {
    return this.validated(PluginRevokeTokenResult, await this.request(METHODS.pluginRevokeToken, { pluginId }), METHODS.pluginRevokeToken);
  }
  close(): void { this.socket.end(); }
}
