import { LIVE_CLOSE_TIMEOUT_MS } from '../src/live/liveProtocol';
import type { LiveCardContext } from '../src/live/liveProtocol';
import { Ledger, LimitError, type LiveSessionRecord } from './ledger';
import { LIVE_INSTRUCTIONS, liveCardAppends, readLiveCards } from './liveContext';

type Run = <T>(operation: (ledger: Ledger) => T) => T;
type Socket = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'readyState'>;
type Connection = { socket: Socket; requestId: string; cards: LiveCardContext; revision: number;
  pending: Map<string, number>; acknowledgments: Map<number, number>; delegations: Set<string> };
export interface LiveManagerDependencies {
  create: (sdp: string) => Promise<{ session: { id: string }; transport: { sdp: string } }>;
  attach: (id: string) => Promise<Socket>;
}

export function openAiLiveDependencies(apiKey: string, request: typeof fetch = fetch): LiveManagerDependencies {
  return {
    async create(sdp) {
      const response = await request('https://api.openai.com/v1/live/sessions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { model: 'gpt-live-1', audio: { output: { voice: 'marin' } },
          store: false, delegation: { type: 'client' }, instructions: LIVE_INSTRUCTIONS }, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new LimitError(response.status === 401 || response.status === 403 ? 'live_access_unavailable' : 'live_provider_failed', 0, 502);
      return await response.json();
    },
    async attach(id) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await request(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`, {
          headers: { Authorization: `Bearer ${apiKey}`, Upgrade: 'websocket' }, signal: controller.signal,
        });
        if (response.status !== 101 || !response.webSocket) throw new LimitError('live_control_failed', 0, 502);
        response.webSocket.accept();
        return response.webSocket as unknown as Socket;
      } finally {
        // Workers retains this signal after upgrade. Limit the handshake, not the conversation.
        clearTimeout(timeout);
      }
    },
  };
}

/** Only accounting metadata crosses run(). Context and reflected audio are never stored. */
export class LiveSessionManager {
  private connections = new Map<string, Connection>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = new Map<string, Promise<{ phase: LiveSessionRecord['phase'] }>>();
  constructor(private run: Run, private dependencies: LiveManagerDependencies, private scheduleAlarm: () => Promise<void>) {}

  async start(visitor: string, id: string, input: Record<string, unknown>) {
    const cards = readLiveCards(input.cards);
    if (typeof input.sdp !== 'string' || !input.sdp.trim() || input.sdp.length > 60_000 || typeof input.requestId !== 'string') throw new LimitError('invalid_request', 0, 400);
    const record = this.run(l => l.liveBegin(visitor, id, input.requestId as string));
    await this.scheduleAlarm();
    try {
      const result = await this.dependencies.create(input.sdp);
      if (typeof result?.session?.id !== 'string' || !result.session.id || result.session.id.length > 200) throw new LimitError('live_invalid_response', 0, 502);
      this.run(l => { l.liveRecord(visitor, id, record.requestId).providerId = result.session.id; });
      const socket = await this.dependencies.attach(result.session.id);
      const connection = this.install(record, socket, cards);
      const current = this.run(l => l.liveRecord(visitor, id, record.requestId));
      if (current.phase !== 'opening' || current.expires <= Date.now() || current.heartbeatExpires <= Date.now()) {
        await this.stop(visitor, id, record.requestId, 'start_cancelled');
        throw new LimitError('live_ended', 0, 409);
      }
      if (typeof result.transport?.sdp !== 'string' || !result.transport.sdp.trim()) throw new LimitError('live_invalid_response', 0, 502);
      this.run(l => { l.liveRecord(visitor, id, record.requestId).phase = 'running'; });
      this.inject(record, connection, cards);
      this.arm(record);
      return { session: { id: result.session.id }, transport: { type: 'webrtc', sdp: result.transport.sdp }, expires: record.expires, requestId: record.requestId };
    } catch (error) {
      this.run(l => { l.liveRecord(visitor, id, record.requestId).failureCode = error instanceof LimitError ? error.code : 'live_start_failed'; });
      await this.stop(visitor, id, record.requestId, 'start_failed');
      throw error;
    }
  }

  private install(record: LiveSessionRecord, socket: Socket, cards: LiveCardContext) {
    const connection: Connection = { socket, requestId: record.requestId, cards, revision: -1,
      pending: new Map(), acknowledgments: new Map(), delegations: new Set() };
    this.connections.set(record.session, connection);
    socket.addEventListener('message', event => {
      if (this.connections.get(record.session) !== connection || typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data); } catch { return; }
      // No reflected audio or transcripts are retained or logged.
      if (message.type === 'session.closed') {
        const usage = message.usage as { seconds?: unknown } | undefined;
        this.run(l => l.liveFinalize(record.visitor, record.session, record.requestId,
          typeof usage?.seconds === 'number' ? usage.seconds : null,
          typeof message.reason === 'string' && /^[a-z_]{1,64}$/.test(message.reason) ? message.reason : 'closed'));
        this.release(record.session, connection);
      } else if (message.type === 'session.usage.updated') {
        const seconds = (message.usage as { seconds?: unknown } | undefined)?.seconds;
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) this.run(l => {
          const r = l.liveRecord(record.visitor, record.session, record.requestId);
          r.seconds = Math.max(r.seconds, seconds);
        });
      } else if (message.type === 'session.thinking.appended') {
        const eventId = message.client_event_id;
        if (typeof eventId !== 'string') return;
        const revision = connection.pending.get(eventId);
        if (revision === undefined) return;
        connection.pending.delete(eventId);
        const left = (connection.acknowledgments.get(revision) ?? 1) - 1;
        connection.acknowledgments.set(revision, left);
        if (left === 0) this.run(l => {
          const r = l.liveRecord(record.visitor, record.session, record.requestId);
          r.confirmedRevision = Math.max(r.confirmedRevision ?? -1, revision);
        });
      } else if (message.type === 'session.delegation.created') {
        const delegation = message.delegation as { id?: unknown } | undefined;
        if (typeof delegation?.id !== 'string' || connection.delegations.has(delegation.id)) return;
        connection.delegations.add(delegation.id);
        if (connection.delegations.size > 100) { void this.stop(record.visitor, record.session, record.requestId, 'delegation_limit'); return; }
        for (const content of ['外部ツールと追加LLMは利用できません。最新のカード配置と通常の会話だけに対応できます。', ...liveCardAppends(connection.cards)]) {
          this.send(connection, { type: 'session.thinking.append', event_id: crypto.randomUUID(), delegation_id: delegation.id, content });
        }
      } else if (message.type === 'error') {
        this.run(l => { l.liveRecord(record.visitor, record.session, record.requestId).failureCode = 'live_command_failed'; });
        void this.stop(record.visitor, record.session, record.requestId, 'provider_error');
      }
    });
    const lost = () => {
      if (this.connections.get(record.session) !== connection) return;
      this.release(record.session, connection);
      this.unconfirmed(record, 'control_lost');
      // Retry only the server close command. Never reconnect browser audio.
      void this.scheduleAlarm();
    };
    socket.addEventListener('close', lost);
    socket.addEventListener('error', lost);
    return connection;
  }
  private send(connection: Connection, value: object) { connection.socket.send(JSON.stringify(value)); }
  private inject(record: LiveSessionRecord, connection: Connection, cards: LiveCardContext) {
    if (cards.swapRevision <= connection.revision) return;
    const chunks = liveCardAppends(cards);
    connection.acknowledgments.set(cards.swapRevision, chunks.length);
    for (const content of chunks) {
      const eventId = crypto.randomUUID();
      connection.pending.set(eventId, cards.swapRevision);
      this.send(connection, { type: 'session.thinking.append', event_id: eventId, delegation_id: null, content });
    }
    connection.cards = cards; connection.revision = cards.swapRevision;
    if (connection.pending.size > 128) { void this.stop(record.visitor, record.session, record.requestId, 'context_unconfirmed'); }
  }
  async update(visitor: string, id: string, input: Record<string, unknown>) {
    if (typeof input.requestId !== 'string') throw new LimitError('invalid_request', 0, 400);
    const cards = input.cards === undefined ? null : readLiveCards(input.cards);
    const result = this.run(l => l.liveTouch(visitor, id, input.requestId as string));
    const record = this.run(l => l.liveRecord(visitor, id, input.requestId as string));
    const connection = this.connections.get(id);
    if (!connection || connection.requestId !== record.requestId) {
      await this.stop(visitor, id, record.requestId, 'control_recovered');
      throw new LimitError('live_ended', 0, 409);
    }
    if (cards) this.inject(record, connection, cards);
    this.arm(record); await this.scheduleAlarm();
    return result;
  }
  private arm(record: LiveSessionRecord) {
    clearTimeout(this.timers.get(record.session));
    const deadline = record.phase === 'closing' ? record.closingAt! + LIVE_CLOSE_TIMEOUT_MS : Math.min(record.expires, record.heartbeatExpires);
    this.timers.set(record.session, setTimeout(() => { void this.sweep(); }, Math.max(1, deadline - Date.now())));
  }
  async stop(visitor: string, id: string, requestId: string, reason = 'close_requested') {
    this.run(l => l.liveRecord(visitor, id, requestId));
    const pending = this.closing.get(id);
    if (pending) return pending;
    const operation = this.closeProvider(visitor, id, requestId, reason).finally(() => this.closing.delete(id));
    this.closing.set(id, operation);
    return operation;
  }
  private unconfirmed(record: LiveSessionRecord, reason: string) {
    this.run(l => {
      l.liveFinalize(record.visitor, record.session, record.requestId, null, reason);
      const r = l.liveRecord(record.visitor, record.session, record.requestId);
      if (r.providerId && (r.closeAttempts ?? 0) < 3) r.retryCloseAt = Date.now() + LIVE_CLOSE_TIMEOUT_MS;
    });
  }
  private async closeProvider(visitor: string, id: string, requestId: string, reason: string) {
    let record = this.run(l => l.liveClosing(visitor, id, requestId, reason));
    if (record.phase === 'closed' || (record.phase === 'unconfirmed' && (record.closeAttempts ?? 0) >= 3)) return { phase: record.phase };
    let connection = this.connections.get(id);
    if (!connection && record.providerId) {
      this.run(l => { const r = l.liveRecord(visitor, id, requestId); r.closeAttempts = (r.closeAttempts ?? 0) + 1; delete r.retryCloseAt; });
      try {
        const socket = await this.dependencies.attach(record.providerId);
        connection = this.install(record, socket, { swapRevision: 0, brainCardIds: [], forcedCardId: null });
        this.run(l => { const r = l.liveRecord(visitor, id, requestId); r.phase = 'closing'; r.closingAt = Date.now(); });
        record = this.run(l => l.liveRecord(visitor, id, requestId));
      } catch { this.unconfirmed(record, reason); }
    }
    if (connection) {
      try { this.send(connection, { type: 'session.close', event_id: crypto.randomUUID() }); }
      catch { this.unconfirmed(record, 'close_failed'); this.release(id, connection); }
    }
    record = this.run(l => l.liveRecord(visitor, id, requestId));
    if (record.phase === 'closing') this.arm(record);
    await this.scheduleAlarm();
    return { phase: record.phase };
  }
  async sweep() {
    const records = this.run(l => Object.values(l.state.liveSessions ?? {}).map(r => ({ ...r })));
    for (const record of records) {
      const invalid = this.run(l => l.state.stopped || !l.state.sessions[record.session] || l.state.sessions[record.session].ended);
      if (record.phase === 'closed') continue;
      if (record.phase === 'unconfirmed') {
        if (record.retryCloseAt && record.retryCloseAt <= Date.now()) await this.stop(record.visitor, record.session, record.requestId, record.reason);
        continue;
      }
      if (record.phase === 'closing' && record.closingAt! + LIVE_CLOSE_TIMEOUT_MS <= Date.now()) {
        this.unconfirmed(record, 'close_unconfirmed');
        const connection = this.connections.get(record.session);
        if (connection) this.release(record.session, connection);
      } else if (invalid || record.expires <= Date.now() || record.heartbeatExpires <= Date.now() || (record.phase === 'running' && !this.connections.has(record.session))) {
        await this.stop(record.visitor, record.session, record.requestId, invalid ? 'public_session_ended' : 'lease_expired');
      } else this.arm(record);
    }
    await this.scheduleAlarm();
  }
  private release(id: string, connection: Connection) {
    this.connections.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id);
    try { connection.socket.close(); } catch { /* Already closed. */ }
  }
}
