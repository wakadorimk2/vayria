import type { Measurements } from './diagnostics';
import { DurableObject } from 'cloudflare:workers';
import { Ledger, LimitError, initialState, type LedgerState, type Limits, type Kind } from './ledger';
import { LiveSessionManager, openAiLiveDependencies } from './liveSessionManager';
import { liveAvailable } from '../src/live/liveProtocol';

export class PublicUsage extends DurableObject {
  private live: LiveSessionManager;
  constructor(ctx: DurableObjectState, private liveEnv: { OPENAI_API_KEY?: string; PUBLIC_BASE_PATH?: string; REQUIRE_PREVIEW_ACCESS?: string }) {
    super(ctx, liveEnv);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
    this.live = new LiveSessionManager(operation => this.run(operation), openAiLiveDependencies(liveEnv.OPENAI_API_KEY ?? ''), () => this.scheduleAlarm());
  }
  private run<T>(operation: (ledger: Ledger) => T): T {
    // No awaits inside this transaction: all visitors and budgets share one serialized ledger.
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM ledger WHERE id = 1').toArray()[0];
      const ledger = new Ledger(row ? JSON.parse(row.state) as LedgerState : initialState(), Date.now());
      const result = operation(ledger);
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO ledger VALUES (1, ?)', JSON.stringify(ledger.state));
      return result;
    });
  }
  private async scheduleAlarm() {
    const next = this.run(l => l.nextAlarm());
    const previous = await this.ctx.storage.getAlarm();
    if (previous === null || next < previous || previous <= Date.now()) await this.ctx.storage.setAlarm(next);
  }
  async alarm() { await this.live.sweep(); await this.scheduleAlarm(); }
  async fetch(request: Request) {
    try {
      const b = await request.json() as { op: string; visitor: string; ip: string; id: string; kind: Kind;
        job: string; amount: number; ticket: string; charge: string; patch: Partial<Limits>; stopped?: boolean; code: string; measurements?: Measurements;
        event: string; starts: number; expires: number; budget: number; hash: string; epoch: number; requestId: string; input?: Record<string, unknown> };
      if (b.op.startsWith('live-')) {
        if (!liveAvailable(this.liveEnv.PUBLIC_BASE_PATH ?? '', this.liveEnv.REQUIRE_PREVIEW_ACCESS ?? '')) throw new LimitError('not_found', 0, 404);
        if (!this.liveEnv.OPENAI_API_KEY) throw new LimitError('configuration_unavailable', 0, 503);
        const input = b.input ?? {};
        const result = b.op === 'live-start' ? await this.live.start(b.visitor, b.id, input)
          : b.op === 'live-context' ? await this.live.update(b.visitor, b.id, input)
          : b.op === 'live-stop' && typeof input.requestId === 'string' ? await this.live.stop(b.visitor, b.id, input.requestId)
          : null;
        if (!result) throw new LimitError('invalid_operation', 0, 400);
        return Response.json(result);
      }
      const result = this.run(l => {
        switch (b.op) {
          case 'status': return l.status(b.visitor);
          case 'attempt': return l.attempt(b.ip);
          case 'start': return l.start(b.visitor, b.ip, b.id, b.epoch);
          case 'exhibition-create': return l.createExhibition(b.event, b.starts, b.expires, b.budget);
          case 'exhibition-code': return l.issueExhibitionCode(b.event, b.hash);
          case 'exhibition-enroll': return l.enrollExhibition(b.visitor, b.hash);
          case 'exhibition-next': return l.nextExhibitionVisitor(b.visitor, b.requestId, b.epoch);
          case 'exhibition-revoke': return l.revokeExhibitionDevice(b.visitor);
          case 'exhibition-stop': return l.stopExhibition(b.event);
          case 'end': return l.end(b.visitor, b.id);
          case 'begin': return l.begin(b.visitor, b.id, b.kind, b.job, b.amount, b.ticket);
          case 'reserve': return l.reserve(b.visitor, b.id, b.job, b.charge, b.amount);
          case 'settle': return l.settle(b.charge, b.amount);
          case 'finish': return l.finish(b.job, b.code, b.measurements);
          case 'reject': return l.reject(b.kind, b.code);
          case 'report': return l.report();
          case 'configure': return l.configure(b.patch ?? {}, b.stopped);
          default: throw new LimitError('invalid_operation', 0, 400);
        }
      });
      if (['end', 'configure', 'exhibition-next', 'exhibition-stop', 'exhibition-revoke'].includes(b.op)) await this.live.sweep();
      const next = this.run(l => l.nextAlarm());
      const previous = await this.ctx.storage.getAlarm();
      if (previous === null || next < previous) await this.ctx.storage.setAlarm(next);
      return Response.json(result ?? {});
    } catch (error) {
      if (error instanceof LimitError) return Response.json({ code: error.code, retryAt: error.retryAt }, { status: error.status });
      return Response.json({ code: 'usage_unavailable' }, { status: 503 });
    }
  }
}
