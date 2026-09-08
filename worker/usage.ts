import type { Measurements } from './diagnostics';
import { DurableObject } from 'cloudflare:workers';
import { Ledger, LimitError, initialState, type LedgerState, type Limits, type Kind } from './ledger';

export class PublicUsage extends DurableObject {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
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
  async alarm() { const next = this.run(l => l.nextAlarm()); await this.ctx.storage.setAlarm(next); }
  async fetch(request: Request) {
    try {
      const b = await request.json() as { op: string; visitor: string; ip: string; id: string; kind: Kind;
        job: string; amount: number; ticket: string; charge: string; patch: Partial<Limits>; stopped?: boolean; code: string; measurements?: Measurements };
      const result = this.run(l => {
        switch (b.op) {
          case 'status': return l.status(b.visitor);
          case 'attempt': return l.attempt(b.ip);
          case 'start': return l.start(b.visitor, b.ip, b.id);
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
