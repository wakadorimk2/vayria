import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Ledger { reservedUsd: number; experiments: Record<string, { requests: number; events: string[] }> }
/** Reservations are never refunded: failed/cancelled remote calls may still be billed. */
export class ManifestationLedger {
  constructor(private root: string, readonly limitUsd = 10) { mkdirSync(root, { recursive: true }); }
  private transact<T>(fn: (ledger: Ledger) => T): T {
    const lock = join(this.root, 'budget.lock');
    const fd = openSync(lock, 'wx');
    try {
      const path = join(this.root, 'budget.json');
      const ledger: Ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { reservedUsd: 0, experiments: {} };
      if (!Number.isFinite(ledger.reservedUsd) || ledger.reservedUsd < 0 || !ledger.experiments) throw new Error('invalid-ledger');
      const result = fn(ledger);
      const temp = join(this.root, 'budget.tmp');
      writeFileSync(temp, JSON.stringify(ledger)); renameSync(temp, path);
      return result;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  createExperiment() { return this.transact(l => { const id = randomUUID(); l.experiments[id] = { requests: 0, events: [] }; return id; }); }
  accept(experiment: string, eventId: string) {
    this.transact(l => {
      const e = l.experiments[experiment];
      if (!e || e.events.includes(eventId)) throw new Error('unknown-or-duplicate-event');
      if (e.events.length >= 1000) throw new Error('event-limit');
      e.events.push(eventId);
    });
  }
  reserve(experiment: string, usd: number) {
    return this.transact(l => {
      const e = l.experiments[experiment];
      if (!e || e.requests >= 20) throw new Error('request-limit');
      if (!Number.isFinite(usd) || usd <= 0 || l.reservedUsd + usd > this.limitUsd + 1e-9) throw new Error('budget-limit');
      e.requests++; l.reservedUsd += usd;
      return { reservedUsd: l.reservedUsd, requests: e.requests };
    });
  }
}
