import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardPool } from '../src/cards/cardPool.js';
import { applyMutation, emptyObservation, isWorldState, type WorldRequest, type WorldResult } from '../src/world/worldState.js';
import type { WorldMediaProvider } from './worldProvider.js';
import { normalizeSceneWorld } from '../src/world/worldScene.js';
import { isWorldLayout } from '../src/world/worldLayout.js';
import { omitWorldEntities, propSpec, WORLD_PROP_ASSETS, type WorldStreamEvent } from '../src/world/worldProps.js';
import { WorldAssetCache } from './worldAssets.js';

export class WorldServiceError extends Error {
  constructor(message: string, readonly status: number, readonly attempts = 0) { super(message); }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function parseWorldRequest(value: unknown): WorldRequest {
  const v = value as WorldRequest | null;
  const cards = new Set<string>(cardPool.map(c => c.id));
  if (v?.layout !== undefined && !isWorldLayout(v.layout)) throw new WorldServiceError('構図の領域が不正です。', 400);
  if (!v || !uuid(v.experimentId) || !uuid(v.eventId) || !Number.isSafeInteger(v.sessionGeneration) || v.sessionGeneration < 0 || !['card', 'autonomous'].includes(v.source) || !(v.cardId === null || cards.has(v.cardId)) || (v.source === 'card' && v.cardId === null) || !Array.isArray(v.brainCardIds) || v.brainCardIds.length !== 5 || new Set(v.brainCardIds).size !== 5 || !v.brainCardIds.every(id => cards.has(id)) || !isWorldState(v.world)) throw new WorldServiceError('世界変化の要求が不正です。', 400);
  if (v.cardInsertedAt !== undefined && (!v.cardInsertedAt || typeof v.cardInsertedAt !== 'object' || Array.isArray(v.cardInsertedAt) || Object.entries(v.cardInsertedAt).some(([id, time]) => !cards.has(id) || !Number.isFinite(time) || time < 0))) throw new WorldServiceError('カードの投入時刻が不正です。', 400);
  return v;
}
interface Ledger { attempts: number; events: string[] }
export class WorldService {
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(private readonly root: string, private readonly provider: WorldMediaProvider, private readonly now = Date.now) {}
  createExperiment(): { experimentId: string; attempts: number } {
    mkdirSync(this.root, { recursive: true });
    const experimentId = randomUUID();
    this.save(experimentId, { attempts: 0, events: [] });
    return { experimentId, attempts: 0 };
  }
  private save(id: string, ledger: Ledger) { writeFileSync(join(this.root, `${id}.json`), JSON.stringify(ledger), 'utf8'); }
  private read(id: string): Ledger {
    try { return JSON.parse(readFileSync(join(this.root, `${id}.json`), 'utf8')) as Ledger; }
    catch { throw new WorldServiceError('実験が見つかりません。「新しい実験」を選んでください。', 404); }
  }
  async mutate(value: unknown, signal: AbortSignal, emit?: (event: WorldStreamEvent) => void): Promise<WorldResult> {
    const request = parseWorldRequest(value);
    const previous = this.active.get(request.experimentId);
    if (previous) {
      if (request.source !== 'card') throw new WorldServiceError('別の世界変化を処理中です。', 409);
      previous.controller.abort();
      await previous.done;
      signal.throwIfAborted();
    }
    const ledger = this.read(request.experimentId);
    if (ledger.events.includes(request.eventId)) throw new WorldServiceError('処理済みのイベントです。', 409, ledger.attempts);
    if (this.active.has(request.experimentId)) throw new WorldServiceError('前の世界変化を取り消しています。少し待って再試行してください。', 409, ledger.attempts);
    if (ledger.attempts >= 20) throw new WorldServiceError('この実験の生成上限20回に達しました。', 429, ledger.attempts);
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.active.set(request.experimentId, { controller, done });
    signal = AbortSignal.any([signal, controller.signal]);
    ledger.events.push(request.eventId);
    const receivedAt = this.now();
    try {
      this.save(request.experimentId, ledger);
      request.world = normalizeSceneWorld(request.world, receivedAt);
      const mutation = await this.provider.plan(request, signal);
      signal.throwIfAborted();
      const plannedAt = this.now();
      const world = applyMutation(request.world, mutation, { now: receivedAt, source: request.source, cardId: request.cardId, brainCardIds: request.brainCardIds, cardInsertedAt: request.cardInsertedAt ?? {} });
      // Held-item motion is deferred. Preserve identities and freshness while releasing old hand anchors.
      for (const entity of [...world.props, ...world.creatures, ...(world.sceneElements ?? []).flatMap(s => s.entities)]) {
        if (entity.placement === 'left_hand' || entity.placement === 'right_hand') entity.placement = 'foreground';
      }
      if (emit && mutation.decision === 'act') {
        const cache = new WorldAssetCache(join(this.root, 'assets'));
        const changedIds = new Set([...mutation.props, ...mutation.creatures].map(e => e.id));
        const priority = (id: string) => (changedIds.has(id) ? 4 : 0) + (world.sceneElements?.some(s => s.slot === 'main' && s.entityIds.includes(id)) ? 2 : 0);
        const candidates = [...world.props, ...world.creatures].filter(e => e.placement !== 'background' && (WORLD_PROP_ASSETS[e.asset] || e.asset === 'generated')).sort((a, b) => priority(b.id) - priority(a.id));
        const resolvedAssets = new Map(candidates.map(e => [e.id, WORLD_PROP_ASSETS[e.asset] ?? cache.read(propSpec(e))]));
        let unknownSelected = false;
        const deliveries = candidates.filter(e => {
          if (resolvedAssets.get(e.id)) return true;
          if (!unknownSelected) { unknownSelected = true; return true; }
          e.placement = 'background'; e.asset = 'none'; return false;
        });
        const assets = deliveries.map(e => resolvedAssets.get(e.id) ?? null);
        // Reserve background first. Reservation is persisted before either request is sent.
        ledger.attempts++;
        const jobs = deliveries.map((e, i) => {
          const previous = [...request.world.props, ...request.world.creatures].find(p => p.id === e.id && p.placement !== 'background');
          // A displayed asset does not arrive again just because the background changed.
          if (assets[i] && previous?.image?.key === assets[i].key && previous.count === e.count) {
            e.image = assets[i];
            world.sceneElements?.forEach(s => s.entities.forEach(entity => { if (entity.id === e.id) entity.image = assets[i]!; }));
            return null;
          }
          if (assets[i]) return { entity: e, asset: assets[i], generate: false };
          if (ledger.attempts >= 20 || !this.provider.generateProp) {
            e.placement = 'background'; e.asset = 'none';
            return null;
          }
          ledger.attempts++;
          return { entity: e, asset: null, generate: true };
        }).filter(j => j !== null);
        this.save(request.experimentId, ledger);
        const pendingIds = new Set(jobs.map(j => j.entity.id));
        const background = omitWorldEntities(world, pendingIds);
        // Planned actions may mention undelivered objects. Only completed visual facts are exposed.
        if (jobs.length) background.recentEvents = world.recentEvents.filter(e => e !== (mutation.action + ' / ' + mutation.sideEffect).slice(0, 240));
        const pendingProps = jobs.map(j => ({ entityId: j.entity.id, placement: j.entity.placement, prominent: world.sceneElements?.some(s => s.slot === 'main' && s.entityIds.includes(j.entity.id)) ?? false, ...(j.asset ? { knownAsset: j.asset.url } : {}) }));
        emit({ type: 'planned', eventId: request.eventId, sessionGeneration: request.sessionGeneration, baseRevision: request.world.revision, backgroundRevision: world.revision, pending: pendingProps, attempts: ledger.attempts });
        const tasks = jobs.map(async job => {
          try {
            let asset = job.asset;
            if (!asset) {
              const generated = await this.provider.generateProp!(propSpec(job.entity), signal);
              signal.throwIfAborted();
              asset = await cache.save(propSpec(job.entity), generated.image, generated.observation);
            }
            signal.throwIfAborted();
            const scene = world.sceneElements?.find(s => s.entityIds.includes(job.entity.id));
            const entity = { ...job.entity, image: asset };
            return { type: 'prop' as const, arrival: { eventId: request.eventId, sessionGeneration: request.sessionGeneration, backgroundRevision: world.revision, entity, scene: scene ? { ...scene, entityIds: [entity.id], entities: [{ ...scene.entities.find(e => e.id === entity.id)!, image: asset }] } : null, category: world.creatures.some(e => e.id === entity.id) ? 'creatures' as const : 'props' as const, attempts: ledger.attempts } };
          } catch (error) { return { type: 'prop_error' as const, eventId: request.eventId, entityId: job.entity.id, error: error instanceof Error ? error.message : '小物が届きませんでした。', attempts: ledger.attempts }; }
        }).map(task => task.then(event => { if (!signal.aborted) emit(event); }));
        const image = await this.provider.generate(background, signal, request.layout);
        signal.throwIfAborted();
        const generatedAt = this.now();
        const observation = await this.provider.observe(image, background, signal);
        signal.throwIfAborted();
        const result: WorldResult = { eventId: request.eventId, sessionGeneration: request.sessionGeneration, baseRevision: request.world.revision, world: background, mutation: jobs.length ? { ...mutation, action: '背景が変わった。小物の有無は表示済みの情報だけを使う。', sideEffect: '', nextInterest: '' } : mutation, media: { kind: 'image', url: image }, observation, attempts: ledger.attempts, timing: { receivedAt, plannedAt, generatedAt, observedAt: this.now() } };
        emit({ type: 'background', result, pending: pendingProps });
        await Promise.all(tasks);
        emit({ type: 'done', attempts: ledger.attempts });
        return result;
      }
      let image: string | null = null;
      let observation = emptyObservation();
      if (mutation.decision === 'act') {
        ledger.attempts += 1;
        this.save(request.experimentId, ledger);
        image = await this.provider.generate(world, signal, request.layout);
      }
      signal.throwIfAborted();
      const generatedAt = this.now();
      if (image) observation = await this.provider.observe(image, world, signal);
      signal.throwIfAborted();
      const result: WorldResult = { eventId: request.eventId, sessionGeneration: request.sessionGeneration, baseRevision: request.world.revision, mutation, world, media: image ? { kind: 'image', url: image } : null, observation, attempts: ledger.attempts, timing: { receivedAt, plannedAt, generatedAt, observedAt: this.now() } };
      if (emit) { emit({ type: 'background', result, pending: [] }); emit({ type: 'done', attempts: ledger.attempts }); }
      return result;
    } catch (error) {
      controller.abort();
      throw new WorldServiceError(error instanceof Error ? error.message : '世界変換に失敗しました。', 502, ledger.attempts);
    } finally { this.active.delete(request.experimentId); release(); }
  }
}
