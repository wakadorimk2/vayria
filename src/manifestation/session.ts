import { isInputEvent, type GeneratedObject, type InputEvent, type Manifestation, type SlotCard } from './types.js';

interface Pending { event: InputEvent; at: number; controller?: AbortController; done: boolean }
export interface SlotSnapshot {
  now: number;
  generation: number;
  sequence: number;
  card: SlotCard | null;
  objects: Manifestation[];
  pending: number;
  history: string[];
  telemetry: { id: string; reason: string; elapsed: number; timings?: Record<string, number>; trace?: GeneratedObject['trace'] }[];
}
export interface SlotDependencies {
  now(): number;
  generate(event: InputEvent, signal: AbortSignal): Promise<GeneratedObject>;
  prepare(media: GeneratedObject, signal: AbortSignal): Promise<void>;
  discard?(media: GeneratedObject): void;
  fallback(): GeneratedObject;
  applyCard(event: InputEvent): boolean;
  displayed?(id: string, description: string): void;
}
/** A shared session owns ordering. UI clients only dispatch inputs and subscribe. */
export class ManifestationSession {
  private listeners = new Set<() => void>();
  private accepted = new Set<string>();
  private jobs: Pending[] = [];
  private active = 0;
  private notices = new Set<string>();
  private audio = new Map<string, number>();
  private snapshot: SlotSnapshot = { now: 0, generation: 0, sequence: 0, card: null, objects: [], pending: 0, history: [], telemetry: [] };
  constructor(readonly id: string, private deps: SlotDependencies) {}
  bind(applyCard: SlotDependencies['applyCard'], displayed: NonNullable<SlotDependencies['displayed']>) {
    this.deps.applyCard = applyCard; this.deps.displayed = displayed;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<SlotSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, now: this.deps.now(), pending: this.jobs.filter(j => !j.done).length };
    this.listeners.forEach(fn => fn());
  }
  dispatch(event: InputEvent): boolean {
    if (!isInputEvent(event) || event.sessionId !== this.id || event.generation !== this.snapshot.generation || this.accepted.has(event.eventId)) return false;
    if (!this.deps.applyCard(event)) return false;
    this.accepted.add(event.eventId);
    const at = this.deps.now();
    this.publish({ sequence: this.snapshot.sequence + 1, card: event.cardId });
    if (event.cardId !== 'chicken') {
      const objects = this.snapshot.objects.map(o => ({ ...o, scale: event.cardId === 'gigantic' ? Math.min(1.6, o.scale * 1.25) : o.scale, effects: [...new Set([...o.effects, event.cardId])] }));
      this.publish({ objects });
      if (objects.some(o => o.visible)) this.deps.displayed?.(event.eventId, event.cardId === 'gigantic' ? '見えている小物が大きくなった。' : event.cardId === 'sparkle' ? '小物の周りに光が現れた。' : '小物の周りに泡が現れた。背景は変わっていない。');
      return true;
    }
    const waiting = this.jobs.find(j => !j.done && !j.controller);
    if (waiting) this.finish(waiting, this.deps.fallback(), 'queue-overflow');
    this.jobs.push({ event, at, done: false });
    this.publish();
    this.pump();
    return true;
  }
  private pump() {
    while (this.active < 2) {
      const job = this.jobs.find(j => !j.done && !j.controller);
      if (!job) return;
      job.controller = new AbortController();
      this.active++;
      const generation = this.snapshot.generation;
      void this.deps.generate(job.event, job.controller.signal).then(async media => {
        if (generation !== this.snapshot.generation) return;
        if (job.done) { this.publish({ telemetry: this.snapshot.telemetry.map(t => t.id === job.event.eventId ? { ...t, trace: media.trace } : t) }); return; }
        await this.deps.prepare(media, job.controller!.signal);
        if (job.done || generation !== this.snapshot.generation) { this.deps.discard?.(media); return; }
        if (this.deps.now() - job.at >= 5000) { this.deps.discard?.(media); this.finish(job, this.deps.fallback(), 'deadline'); }
        else this.finish(job, media, 'generated');
      }).catch((error: unknown) => {
        if (generation === this.snapshot.generation && !job.done) this.finish(job, this.deps.fallback(), error instanceof Error ? error.message.slice(0, 120) : 'generation-failed');
      }).finally(() => { this.active--; this.pump(); });
    }
  }
  private finish(job: Pending, media: GeneratedObject, reason: string) {
    if (job.done || job.event.generation !== this.snapshot.generation) return;
    job.done = true;
    const now = this.deps.now();
    const object: Manifestation = { ...media, id: job.event.eventId, insertedAt: job.at, displayedAt: now, scale: 1, effects: [], visible: false };
    const objects = [...this.snapshot.objects, object].sort((a, b) => a.insertedAt - b.insertedAt).slice(-3);
    const audioStartedAt = this.audio.get(object.id);
    this.publish({ objects, telemetry: [...this.snapshot.telemetry, { id: object.id, reason, elapsed: now - job.at, trace: media.trace, timings: { ...media.timings, inputAt: job.at, ...(audioStartedAt === undefined ? {} : { audioStartedAt }) } }].slice(-40) });
  }
  markVisible(id: string, visible: boolean) {
    const object = this.snapshot.objects.find(o => o.id === id);
    if (!object || object.visible === visible) return;
    this.publish({ objects: this.snapshot.objects.map(o => o.id === id ? { ...o, visible } : o) });
    if (visible && !this.notices.has(id)) {
      this.notices.add(id);
      this.publish({ telemetry: this.snapshot.telemetry.map(t => t.id === id ? { ...t, timings: { ...t.timings, firstDisplayedAt: this.deps.now() } } : t) });
      const description = 'Vayriaの近くに鶏の小物が現れた。手で握ってはいない。細部や動きは未確認。';
      this.publish({ history: [...this.snapshot.history, description].slice(-8) });
      this.deps.displayed?.(id, description);
    }
  }
  markAudioStarted() {
    const now = this.deps.now();
    // This records the next playback after the latest input, not speaker attribution.
    const id = [...this.accepted].at(-1);
    if (!id || this.audio.has(id)) return;
    this.audio.set(id, now);
    this.publish({ telemetry: this.snapshot.telemetry.map(t => t.id === id ? { ...t, timings: { ...t.timings, audioStartedAt: now } } : t) });
  }
  cancelPending() {
    this.jobs.forEach(job => { if (!job.done) { job.done = true; job.controller?.abort(); } });
    this.publish();
  }
  tick() {
    const now = this.deps.now();
    for (const job of this.jobs) {
      if (!job.done && now - job.at >= 5000) this.finish(job, this.deps.fallback(), 'deadline');
      if (now - job.at >= 10000) job.controller?.abort();
    }
    this.jobs = this.jobs.filter(j => !j.done || now - j.at < 10000);
    const objects = this.snapshot.objects.filter(o => now - o.displayedAt < 45000);
    if (objects.length !== this.snapshot.objects.length || Math.floor(now / 1000) !== Math.floor(this.snapshot.now / 1000)) this.publish({ objects });
  }
  reset() {
    this.jobs.forEach(j => { j.done = true; j.controller?.abort(); });
    this.jobs = []; this.accepted.clear(); this.notices.clear(); this.audio.clear();
    this.publish({ generation: this.snapshot.generation + 1, sequence: 0, card: null, objects: [], history: [], telemetry: [] });
  }
}
export function manifestationContext(snapshot: SlotSnapshot): string {
  return ['現在画面に表示されている対象:', ...snapshot.objects.filter(o => o.visible).map(o => `鶏の小物${o.scale > 1 ? '（拡大表示）' : ''}。周囲の演出: ${o.effects.join(',') || 'なし'}。握っていない。`), '過去の出来事（現在見えているとは限らない）:', ...snapshot.history, '投入されたカードは未完成の物体の存在を保証しない。仮エフェクトを鶏や完成品と呼ばない。動画の具体的な動作・細部は未確認なので断定しない。'].join('\n');
}
