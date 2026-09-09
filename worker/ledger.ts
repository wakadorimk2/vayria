import { distribution, sanitizeMeasurements, safeMetricCode, timingFields, type Measurements } from './diagnostics';
// All monetary values are integer micro-yen. No conversation content belongs here.
export const DEFAULT_LIMITS = {
  visitorDay: 2, visitorMonth: 10, ipMinute: 10, ipHour: 30, ipDay: 100,
  sessionSeconds: 180, user: 6, autonomous: 2, card: 2,
  transcribe: 8, audioSeconds: 120, tts: 20, ttsChars: 600, concurrency: 5,
  dayBudget: 70_000_000, monthBudget: 3_500_000_000,
  usdJpy: 150, infrastructureYen: 1000, warningYen: 2000, targetYen: 3000,
};
export type Limits = typeof DEFAULT_LIMITS;
export type Kind = 'user' | 'autonomous' | 'card' | 'transcribe' | 'tts';
type Counter = { value: number; expires: number };
export type Exhibition = { id: string; starts: number; expires: number; budget: number; used: number; stopped: boolean };
type ExhibitionDevice = { event: string; epoch: number; revoked: boolean; lastHandoff?: string };
export type Session = {
  id: string; visitor: string; expires: number; created: number; paid: boolean; ended: boolean;
  day: string; month: string; counts: Record<Kind, number>; audioSeconds: number; ttsChars: number;
  closedAt?: number;
  exhibition?: string; epoch?: number;
};
type Job = { session: string; kind: Kind; expires: number };
type Charge = { amount: number; day: string; month: string; settled: boolean; expires: number; exhibition?: string };
export type LedgerState = {
  limits: Limits; stopped: boolean; sessions: Record<string, Session>; counters: Record<string, Counter>;
  jobs: Record<string, Job>; charges: Record<string, Charge>; usedTickets: Record<string, number>;
  exhibitions?: Record<string, Exhibition>;
  exhibitionDevices?: Record<string, ExhibitionDevice>;
  exhibitionCodes?: Record<string, { event: string; expires: number }>;
  metrics?: { at: number; kind: Kind; durationMs: number; code: string; rejected?: boolean; measurements?: Measurements }[];
};
export function initialState(): LedgerState {
  return { limits: { ...DEFAULT_LIMITS }, stopped: false, sessions: {}, counters: {}, jobs: {}, charges: {}, usedTickets: {} };
}
export class LimitError extends Error {
  constructor(readonly code: string, readonly retryAt = 0, readonly status = 429) { super(code); }
}
export function periods(now: number) {
  const date = new Date(now + 9 * 3600_000);
  const day = date.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return { day, month, dayEnd: Date.parse(day + 'T00:00:00+09:00') + 86400_000,
    monthEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 9 * 3600_000 };
}
export class Ledger {
  constructor(readonly state: LedgerState, readonly now: number) { this.cleanup(); }
  private count(key: string) { return this.state.counters[key]?.value ?? 0; }
  private add(key: string, amount: number, expires: number) {
    this.state.counters[key] = { value: Math.max(0, this.count(key) + amount), expires };
  }
  private limit(key: string, max: number, code: string, retry: number) {
    if (this.count(key) >= max) throw new LimitError(code, retry);
  }
  private close(s: Session) {
    if (s.ended) return;
    s.ended = true;
    s.closedAt = Math.min(this.now, s.expires);
    if (!s.paid && !s.exhibition) {
      for (const key of [`vd:${s.visitor}:${s.day}`, `vm:${s.visitor}:${s.month}`]) {
        const counter = this.state.counters[key];
        if (counter) counter.value = Math.max(0, counter.value - 1);
      }
    }
  }
  cleanup() {
    this.state.exhibitions ??= {};
    this.state.exhibitionDevices ??= {};
    this.state.exhibitionCodes ??= {};
    for (const [key, code] of Object.entries(this.state.exhibitionCodes)) if (code.expires <= this.now) delete this.state.exhibitionCodes[key];
    this.state.metrics = (this.state.metrics ?? []).filter(m => m.at + 86400_000 > this.now).slice(-2000);
    for (const [id, s] of Object.entries(this.state.sessions)) {
      if (s.expires <= this.now) this.close(s);
      if ((s.closedAt ?? s.expires) + 86400_000 <= this.now) delete this.state.sessions[id];
    }
    for (const [id, c] of Object.entries(this.state.counters)) if (c.expires <= this.now) delete this.state.counters[id];
    for (const [id, j] of Object.entries(this.state.jobs)) if (j.expires <= this.now) delete this.state.jobs[id];
    for (const [id, c] of Object.entries(this.state.charges)) if (c.expires <= this.now) delete this.state.charges[id];
    for (const [id, expiry] of Object.entries(this.state.usedTickets)) if (expiry <= this.now) delete this.state.usedTickets[id];
  }
  status(visitor: string) {
    const p = periods(this.now); const l = this.state.limits;
    const session = Object.values(this.state.sessions).find(s => s.visitor === visitor && !s.ended);
    return { session: session ? { id: session.id, expires: session.expires, counts: session.counts } : null,
      remainingDay: Math.max(0, l.visitorDay - this.count(`vd:${visitor}:${p.day}`)),
      remainingMonth: Math.max(0, l.visitorMonth - this.count(`vm:${visitor}:${p.month}`)),
      dayResetAt: p.dayEnd, monthResetAt: p.monthEnd, stopped: this.state.stopped,
      exhibition: this.exhibitionStatus(visitor) };
  }
  exhibitionStatus(visitor: string) {
    const device = this.state.exhibitionDevices![visitor];
    const event = device && this.state.exhibitions![device.event];
    if (!device || !event) return null;
    return { id: event.id, starts: event.starts, expires: event.expires, epoch: device.epoch,
      budgetYen: event.budget / 1e6, usedYen: event.used / 1e6,
      warning: event.used >= event.budget * .8 ? '80' : event.used >= event.budget * .5 ? '50' : null,
      available: !device.revoked && !event.stopped && this.now >= event.starts && this.now < event.expires && event.used < event.budget,
      revoked: device.revoked, stopped: event.stopped };
  }
  createExhibition(id: string, starts: number, expires: number, budget: number) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || this.state.exhibitions![id] ||
      !Number.isSafeInteger(starts) || !Number.isSafeInteger(expires) || starts < 0 || expires <= Math.max(starts, this.now) ||
      expires - starts > 86400_000 || !Number.isSafeInteger(budget) || budget <= 0) throw new LimitError('invalid_config', 0, 400);
    this.state.exhibitions![id] = { id, starts, expires, budget, used: 0, stopped: false };
    return this.state.exhibitions![id];
  }
  issueExhibitionCode(event: string, hash: string) {
    const e = this.state.exhibitions![event];
    if (!e || e.expires <= this.now || !/^[a-f0-9]{64}$/.test(hash)) throw new LimitError('invalid_config', 0, 400);
    const expires = Math.min(this.now + 900_000, e.expires);
    this.state.exhibitionCodes![hash] = { event, expires };
    return { expires };
  }
  enrollExhibition(visitor: string, hash: string) {
    const code = this.state.exhibitionCodes![hash];
    if (!code || code.expires <= this.now) throw new LimitError('exhibition_code_invalid', 0, 403);
    const current = this.state.exhibitionDevices![visitor];
    if (current && current.event !== code.event && this.state.exhibitions![current.event].expires > this.now) throw new LimitError('exhibition_already_registered', 0, 409);
    this.endVisitorSessions(visitor);
    this.state.exhibitionDevices![visitor] = { event: code.event, epoch: (current?.epoch ?? 0) + 1, revoked: false };
    delete this.state.exhibitionCodes![hash];
    return this.status(visitor);
  }
  private endVisitorSessions(visitor: string) {
    for (const s of Object.values(this.state.sessions)) if (s.visitor === visitor) this.close(s);
  }
  nextExhibitionVisitor(visitor: string, requestId: string, epoch: number) {
    const device = this.state.exhibitionDevices![visitor];
    if (!device) throw new LimitError('exhibition_required', 0, 403);
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || !Number.isSafeInteger(epoch)) throw new LimitError('invalid_request', 0, 400);
    if (device.lastHandoff === requestId) return this.status(visitor);
    if (device.epoch !== epoch) throw new LimitError('exhibition_stale', 0, 409);
    this.endVisitorSessions(visitor); device.epoch++;
    device.lastHandoff = requestId;
    return this.status(visitor);
  }
  stopExhibition(event: string) {
    const e = this.state.exhibitions![event];
    if (!e) throw new LimitError('exhibition_required', 0, 404);
    e.stopped = true;
    for (const s of Object.values(this.state.sessions)) if (s.exhibition === event) this.close(s);
    return e;
  }
  revokeExhibitionDevice(visitor: string) {
    const device = this.state.exhibitionDevices![visitor];
    if (!device) throw new LimitError('exhibition_required', 0, 404);
    this.endVisitorSessions(visitor); device.revoked = true; device.epoch++;
    return { revoked: true };
  }
  private exhibitionEvent(visitor: string, eventId?: string, epoch?: number) {
    const device = this.state.exhibitionDevices![visitor];
    const e = device && this.state.exhibitions![device.event];
    if (!device || !e || device.revoked || (eventId !== undefined && (eventId !== e.id || epoch !== device.epoch))) throw new LimitError('exhibition_unavailable', 0, 403);
    if (e.stopped || this.now < e.starts || this.now >= e.expires) throw new LimitError('exhibition_unavailable', this.now < e.starts ? e.starts : 0, 403);
    return e;
  }
  nextAlarm() {
    const times = [this.now + 3600_000,
      ...Object.values(this.state.sessions).map(s => s.ended ? (s.closedAt ?? s.expires) + 86400_000 : s.expires),
      ...Object.values(this.state.counters).map(c => c.expires),
      ...Object.values(this.state.jobs).map(j => j.expires),
      ...Object.values(this.state.charges).map(c => c.expires),
      ...Object.values(this.state.usedTickets),
      ...(this.state.metrics ?? []).map(m => m.at + 86400_000)];
    return Math.max(this.now + 1, Math.min(...times));
  }
  attempt(ip: string) {
    const minute = Math.floor(this.now / 60_000);
    const key = `ipm:${ip}:${minute}`; const end = (minute + 1) * 60_000;
    this.limit(key, this.state.limits.ipMinute, 'ip_rate_limit', end);
    this.add(key, 1, end + 60_000);
  }
  start(visitor: string, ip: string, id: string, epoch?: number) {
    if (this.state.stopped) throw new LimitError('generation_stopped', 0, 503);
    if (this.state.exhibitionDevices![visitor]) {
      const device = this.state.exhibitionDevices![visitor];
      const e = this.exhibitionEvent(visitor, device.event, epoch);
      this.checkBudget(0, e.id);
      if (this.status(visitor).session) return this.status(visitor);
      const p = periods(this.now);
      this.state.sessions[id] = { id, visitor, created: this.now, expires: e.expires, paid: false, ended: false,
        day: p.day, month: p.month, exhibition: e.id, epoch: device.epoch,
        counts: { user: 0, autonomous: 0, card: 0, transcribe: 0, tts: 0 }, audioSeconds: 0, ttsChars: 0 };
      return this.status(visitor);
    }
    const current = this.status(visitor).session;
    if (current) return this.status(visitor);
    const p = periods(this.now); const l = this.state.limits;
    const hour = Math.floor(this.now / 3600_000); const hourEnd = (hour + 1) * 3600_000;
    this.limit(`vd:${visitor}:${p.day}`, l.visitorDay, 'visitor_day_limit', p.dayEnd);
    this.limit(`vm:${visitor}:${p.month}`, l.visitorMonth, 'visitor_month_limit', p.monthEnd);
    this.limit(`iph:${ip}:${hour}`, l.ipHour, 'ip_rate_limit', hourEnd);
    this.limit(`ipd:${ip}:${p.day}`, l.ipDay, 'ip_day_limit', p.dayEnd);
    this.checkBudget(0);
    this.add(`vd:${visitor}:${p.day}`, 1, p.dayEnd + 2 * 86400_000);
    this.add(`vm:${visitor}:${p.month}`, 1, p.monthEnd + 7 * 86400_000);
    this.add(`iph:${ip}:${hour}`, 1, hourEnd + 3600_000);
    this.add(`ipd:${ip}:${p.day}`, 1, p.dayEnd + 2 * 86400_000);
    this.state.sessions[id] = { id, visitor, created: this.now, expires: this.now + l.sessionSeconds * 1000,
      paid: false, ended: false, day: p.day, month: p.month,
      counts: { user: 0, autonomous: 0, card: 0, transcribe: 0, tts: 0 }, audioSeconds: 0, ttsChars: 0 };
    return this.status(visitor);
  }
  private session(visitor: string, id: string) {
    const s = this.state.sessions[id];
    if (!s || s.visitor !== visitor || s.ended || s.expires <= this.now) throw new LimitError('session_expired', 0, 401);
    if (s.exhibition) this.exhibitionEvent(visitor, s.exhibition, s.epoch);
    return s;
  }
  end(visitor: string, id: string) {
    const s = this.state.sessions[id];
    if (s?.visitor === visitor) this.close(s);
    return this.status(visitor);
  }
  begin(visitor: string, id: string, kind: Kind, jobId: string, amount = 0, ticket = '') {
    const s = this.session(visitor, id); const l = this.state.limits;
    if (this.state.stopped) throw new LimitError('generation_stopped', 0, 503);
    if (!['user', 'autonomous', 'card', 'transcribe', 'tts'].includes(kind)) throw new LimitError('invalid_request', 0, 400);
    if (!Number.isFinite(amount) || amount < 0) throw new LimitError('invalid_request', 0, 400);
    if (s.exhibition && kind === 'autonomous') throw new LimitError('exhibition_idle', 0, 403);
    if (!s.exhibition && s.counts[kind] >= l[kind]) throw new LimitError(`${kind}_limit`, s.expires);
    if (!s.exhibition && kind === 'transcribe' && s.counts.user >= l.user) throw new LimitError('user_limit', s.expires);
    const jobs = Object.values(this.state.jobs);
    const occupied = new Set(jobs.map(j => j.session));
    if (!occupied.has(id) && occupied.size >= l.concurrency) throw new LimitError('busy', this.now + 5000);
    // TTS units may overlap with their generating chat, but not with another TTS unit.
    if (jobs.some(j => j.session === id && (kind === 'tts' ? j.kind === 'tts' : j.kind !== 'tts'))) throw new LimitError('busy', this.now + 1000);
    if (kind === 'transcribe' && (amount > 20 || (!s.exhibition && s.audioSeconds + amount > l.audioSeconds))) throw new LimitError('audio_limit', s.expires);
    if (kind === 'tts' && (!ticket || this.state.usedTickets[ticket])) throw new LimitError('ticket_used', 0, 409);
    if (!s.exhibition && kind === 'tts' && s.ttsChars + amount > l.ttsChars) throw new LimitError('tts_limit', s.expires);
    this.checkBudget(0, s.exhibition);
    s.counts[kind]++;
    if (kind === 'transcribe') s.audioSeconds += amount;
    if (kind === 'tts') { s.ttsChars += amount; this.state.usedTickets[ticket] = s.expires + 120_000; }
    this.state.jobs[jobId] = { session: id, kind, expires: this.now + 120_000 };
    return { expires: s.expires, limits: l };
  }
  private checkBudget(amount: number, exhibition?: string) {
    if (exhibition) {
      const e = this.state.exhibitions![exhibition];
      if (e.used >= e.budget || e.used + amount > e.budget) throw new LimitError('exhibition_budget', 0);
      return;
    }
    const p = periods(this.now); const l = this.state.limits;
    if (this.count(`bd:${p.day}`) + amount >= l.dayBudget) throw new LimitError('daily_budget', p.dayEnd);
    if (this.count(`bm:${p.month}`) + amount >= l.monthBudget) throw new LimitError('monthly_budget', p.monthEnd);
  }
  reserve(visitor: string, sessionId: string, jobId: string, chargeId: string, amount: number) {
    const s = this.session(visitor, sessionId);
    if (!this.state.jobs[jobId] || this.state.jobs[jobId].session !== sessionId) throw new LimitError('job_expired', 0, 409);
    if (this.state.stopped) throw new LimitError('generation_stopped', 0, 503);
    if (!Number.isSafeInteger(amount) || amount <= 0 || this.state.charges[chargeId]) throw new LimitError('invalid_charge', 0, 400);
    this.checkBudget(amount, s.exhibition);
    const p = periods(this.now);
    if (s.exhibition) this.state.exhibitions![s.exhibition].used += amount;
    else {
      this.add(`bd:${p.day}`, amount, p.dayEnd + 2 * 86400_000);
      this.add(`bm:${p.month}`, amount, p.monthEnd + 7 * 86400_000);
    }
    this.state.charges[chargeId] = { amount, day: p.day, month: p.month, settled: false, expires: p.monthEnd + 7 * 86400_000, exhibition: s.exhibition };
    s.paid = true;
  }
  settle(chargeId: string, actual: number) {
    const c = this.state.charges[chargeId];
    if (!c || c.settled) return;
    if (!Number.isSafeInteger(actual) || actual < 0) throw new LimitError('invalid_charge', 0, 400);
    if (c.exhibition) {
      const e = this.state.exhibitions![c.exhibition];
      e.used = Math.max(0, e.used + actual - c.amount);
      if (actual > c.amount) e.stopped = true;
    } else {
      if (actual > c.amount) this.state.stopped = true;
      for (const key of [`bd:${c.day}`, `bm:${c.month}`]) {
      const counter = this.state.counters[key];
      if (counter) counter.value = Math.max(0, counter.value + actual - c.amount);
      }
    }
    c.amount = actual; c.settled = true;
  }
  finish(jobId: string, code = 'complete', measurements?: Measurements) {
    const job = this.state.jobs[jobId];
    if (job) this.state.metrics!.push({ at: this.now, kind: job.kind, durationMs: Math.max(0, this.now - (job.expires - 120_000)),
      code: safeMetricCode(code), measurements: sanitizeMeasurements(measurements) });
    this.state.metrics = this.state.metrics!.slice(-2000);
    delete this.state.jobs[jobId];
  }
  reject(kind: Kind, code: string) {
    if (!['user', 'autonomous', 'card', 'transcribe', 'tts'].includes(kind)) return;
    this.state.metrics!.push({ at: this.now, kind, durationMs: 0, code: safeMetricCode(code), rejected: true });
    this.state.metrics = this.state.metrics!.slice(-2000);
  }
  report() {
    const p = periods(this.now); const l = this.state.limits;
    const estimatedYen = this.count(`bm:${p.month}`) / 1e6 + l.infrastructureYen;
    return { limits: l, stopped: this.state.stopped, dayYen: this.count(`bd:${p.day}`) / 1e6,
      exhibitions: Object.values(this.state.exhibitions!), exhibitionDevices: this.state.exhibitionDevices,
      monthApiYen: this.count(`bm:${p.month}`) / 1e6, estimatedYen,
      warning: estimatedYen >= l.targetYen ? 'target_exceeded' : estimatedYen >= l.warningYen ? 'warning' : null,
      activeJobs: Object.keys(this.state.jobs).length,
      recentByKind: Object.fromEntries((['user', 'autonomous', 'card', 'transcribe', 'tts'] as Kind[]).map(kind => {
        const rows = (this.state.metrics ?? []).filter(m => m.kind === kind);
        const started = rows.filter(m => !m.rejected);
        const failures: Record<string, number> = {};
        const models: Record<string, number> = {};
        for (const row of rows) {
          if (row.code !== 'complete') { const code = safeMetricCode(row.code); failures[code] = (failures[code] ?? 0) + 1; }
          for (const model of sanitizeMeasurements(row.measurements).actualModels ?? []) models[model] = (models[model] ?? 0) + 1;
        }
        return [kind, { requests: rows.length, started: started.length, rejected: rows.length - started.length,
          failures, actualModels: models, duration: distribution(started.map(m => m.durationMs)),
          timings: Object.fromEntries(timingFields.map(field => [field, distribution(started.flatMap(m =>
            m.measurements?.[field] === undefined ? [] : [m.measurements[field]!]))])),
          llmCalls: started.reduce((n,m) => n + (m.measurements?.llmCalls ?? 0), 0),
          llmRetries: started.reduce((n,m) => n + (m.measurements?.llmRetries ?? 0), 0) }];
      })),
      recentRequests: this.state.metrics?.filter(m => !m.rejected).length ?? 0,
      recentFailures: this.state.metrics?.filter(m => !m.rejected && m.code !== 'complete').length ?? 0,
      recentDurationMedianMs: [...(this.state.metrics ?? [])].filter(m => !m.rejected).sort((a, b) => a.durationMs - b.durationMs)[Math.floor((this.state.metrics?.filter(m => !m.rejected).length ?? 0) / 2)]?.durationMs ?? null };
  }
  configure(patch: Partial<Limits>, stopped?: boolean) {
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value! <= 0) throw new LimitError('invalid_config', 0, 400);
    }
    Object.assign(this.state.limits, patch);
    if (stopped !== undefined) this.state.stopped = stopped;
    return this.report();
  }
}
