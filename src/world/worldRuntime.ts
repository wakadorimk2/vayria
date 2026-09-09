import { emptyObservation, initialWorld, isWorldState, type WorldObservation, type WorldRequest, type WorldResult, type WorldState } from './worldState.js';
import { sampleWorldDrive, type WorldDrive } from './worldDrive.js';
import { sceneDiagnostics } from './worldScene.js';
import { isWorldEntity } from './worldState.js';
import { foregroundPlacements, validPropAsset, type PendingWorldProp, type PropArrival, type WorldStreamEvent } from './worldProps.js';
import { fallbackLayout, type WorldLayout } from './worldLayout.js';
export interface WorldSnapshot {
  world: WorldState;
  observation: WorldObservation;
  imageUrl: string | null;
  phase: 'idle' | 'pending' | 'ready' | 'error';
  source: 'card' | 'autonomous' | null;
  event: string;
  error: string | null;
  attempts: number;
  experimentId: string | null;
  generation: number;
  drive: WorldDrive | null;
  lastResult: WorldResult | null;
  displayedAt: number | null;
  reactionStartedAt: number | null;
  sceneDiagnostics?: ReturnType<typeof sceneDiagnostics>;
  pendingProps: PendingWorldProp[];
  readyProps: number;
  propObservation: WorldObservation;
  propDisplayedAt: number | null;
  propReactionStartedAt: number | null;
  presenceShownAt?: number | null;
  layout: WorldLayout;
  editLayout: boolean;
}
export interface WorldRuntimeDependencies {
  post(path: string, value: unknown, signal: AbortSignal): Promise<unknown>;
  loadImage(url: string, signal: AbortSignal): Promise<void>;
  now(): number;
  id(): string;
  random(): number;
  readExperiment(): string | null;
  saveExperiment(id: string): void;
  stream?(request: WorldRequest, signal: AbortSignal, receive: (event: WorldStreamEvent) => Promise<void>): Promise<void>;
}
export class WorldRuntime {
  private state: WorldSnapshot;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private serial = 0;
  private pending: WorldResult | null = null;
  private lastActionAt: number;
  private lastInputAt: number;
  private retryInput: { cardId: string; brainCardIds: string[] } | null = null;
  private cardInsertedAt: Record<string, number> = {};
  private initialCardsAt: number;
  private arrivals: PropArrival[] = [];
  private backgroundEventId = '';
  private backgroundRevision = -1;
  private progressive = false;
  private expectedRevision = 0;
  private earlyArrivals: PropArrival[] = [];
  private settledProps = new Set<string>();
  constructor(private deps: WorldRuntimeDependencies) {
    this.lastActionAt = this.lastInputAt = deps.now();
    this.initialCardsAt = this.lastInputAt;
    this.state = { world: initialWorld(), observation: emptyObservation(), imageUrl: null, phase: 'idle', source: null, event: '', error: null, attempts: 0, experimentId: deps.readExperiment(), generation: 0, drive: null, lastResult: null, displayedAt: null, reactionStartedAt: null, pendingProps: [], readyProps: 0, propObservation: emptyObservation(), propDisplayedAt: null, propReactionStartedAt: null, layout: fallbackLayout(), editLayout: false };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(next: Partial<WorldSnapshot>) { this.state = { ...this.state, ...next }; this.listeners.forEach(fn => fn()); }
  setLayout = (layout: WorldLayout) => { this.state = { ...this.state, layout }; };
  toggleLayout = () => this.update({ editLayout: !this.state.editLayout });
  markPresenceShown = () => { if (this.state.presenceShownAt == null) this.update({ presenceShownAt: this.deps.now() }); };
  cancel = () => {
    this.serial += 1;
    this.controller?.abort(); this.controller = null; this.pending = null;
    this.arrivals = []; this.backgroundEventId = ''; this.backgroundRevision = -1;
    this.progressive = false; this.earlyArrivals = []; this.settledProps.clear();
    this.lastActionAt = this.deps.now();
    this.update({ phase: 'idle', source: null, error: null, pendingProps: [], readyProps: 0, event: '世界変化を取り消した。現在世界は変わっていない。' });
  };
  reset = () => {
    this.cancel(); this.retryInput = null;
    this.cardInsertedAt = {};
    this.lastActionAt = this.lastInputAt = this.deps.now();
    this.initialCardsAt = this.lastInputAt;
    this.update({ world: initialWorld(), imageUrl: null, observation: emptyObservation(), generation: this.state.generation + 1, lastResult: null, event: '', drive: null, displayedAt: null, reactionStartedAt: null, propObservation: emptyObservation(), propDisplayedAt: null, propReactionStartedAt: null, sceneDiagnostics: [] });
  };
  newExperiment = async () => {
    this.reset();
    const serial = this.serial;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await this.deps.post('/api/world/experiments', {}, controller.signal) as { experimentId: string };
      if (serial !== this.serial) return;
      if (typeof result.experimentId !== 'string') throw new Error('実験を開始できませんでした。');
      this.deps.saveExperiment(result.experimentId);
      this.update({ experimentId: result.experimentId, attempts: 0 });
    } catch (error) { if (serial === this.serial) this.update({ phase: 'error', error: error instanceof Error ? error.message : '実験を開始できませんでした。' }); }
  };
  card = async (cardId: string, brainCardIds: string[]) => {
    for (const id of brainCardIds) this.cardInsertedAt[id] ??= this.initialCardsAt;
    this.lastInputAt = this.deps.now();
    this.cardInsertedAt[cardId] = this.lastInputAt;
    this.retryInput = { cardId, brainCardIds };
    await this.run('card', cardId, brainCardIds);
  };
  retry = () => this.retryInput ? this.run('card', this.retryInput.cardId, this.retryInput.brainCardIds) : Promise.resolve();
  private async run(source: 'card' | 'autonomous', cardId: string | null, brainCardIds: string[]) {
    this.cancel();
    const serial = this.serial;
    const controller = new AbortController(); this.controller = controller;
    this.update({ phase: 'pending', source, propDisplayedAt: null, propReactionStartedAt: null, event: source === 'card' ? `カード ${cardId} を受け取った。結果はまだわからない。` : '今の世界で気になる対象について、何かしようとしている。', error: null });
    try {
      let experimentId = this.state.experimentId;
      if (!experimentId) {
        const created = await this.deps.post('/api/world/experiments', {}, controller.signal) as { experimentId: string };
        if (serial !== this.serial) return;
        experimentId = created.experimentId;
        this.deps.saveExperiment(experimentId); this.update({ experimentId });
      }
      const request: WorldRequest = { experimentId, sessionGeneration: this.state.generation, eventId: this.deps.id(), source, cardId, brainCardIds, cardInsertedAt: { ...this.cardInsertedAt }, world: this.state.world, layout: this.state.layout };
      this.expectedRevision = request.world.revision;
      if (this.deps.stream) {
        await this.deps.stream(request, controller.signal, async event => {
          if (serial !== this.serial) return;
          if (event.type === 'planned') {
            if (this.progressive || event.eventId !== request.eventId || event.sessionGeneration !== this.state.generation || event.baseRevision !== request.world.revision || event.backgroundRevision !== request.world.revision + 1) throw new Error('小物のイベント情報が不正です。');
            this.progressive = true; this.backgroundEventId = request.eventId; this.backgroundRevision = event.backgroundRevision;
            this.update({ pendingProps: event.pending, attempts: event.attempts });
          } else if (event.type === 'background') {
            await this.receiveBackground(event.result, request, serial, controller.signal);
            if (serial !== this.serial) return;
            this.backgroundEventId = request.eventId; this.backgroundRevision = event.result.world.revision;
            if (!this.progressive) this.update({ pendingProps: event.pending });
          } else if (event.type === 'prop') {
            const a = event.arrival;
            if (a.eventId !== request.eventId || a.sessionGeneration !== this.state.generation || a.backgroundRevision !== this.backgroundRevision || !isWorldEntity(a.entity) || !validPropAsset(a.entity.image) || !this.state.pendingProps.some(p => p.entityId === a.entity.id) || this.settledProps.has(a.entity.id) || this.arrivals.some(p => p.entity.id === a.entity.id)) return;
            await this.deps.loadImage(a.entity.image.url, controller.signal).catch(() => { if (serial === this.serial) this.update({ pendingProps: this.state.pendingProps.filter(p => p.entityId !== a.entity.id) }); });
            if (serial !== this.serial || !this.state.pendingProps.some(p => p.entityId === a.entity.id)) return;
            this.arrivals.push(a); this.update({ readyProps: this.arrivals.length, attempts: a.attempts });
          } else if (event.type === 'prop_error') {
            this.settledProps.add(event.entityId);
            if (event.eventId === request.eventId) this.update({ pendingProps: this.state.pendingProps.filter(p => p.entityId !== event.entityId), attempts: event.attempts, error: event.error });
          } else if (event.type === 'error') throw Object.assign(new Error(event.error), { attempts: event.attempts });
          else if (event.type === 'done') this.update({ attempts: event.attempts });
        });
        return;
      }
      const result = await this.deps.post('/api/world/mutate', request, controller.signal) as WorldResult;
      await this.receiveBackground(result, request, serial, controller.signal);
    } catch (error) {
      if (serial !== this.serial) return;
      controller.abort();
      const attempts = (error as { attempts?: number }).attempts;
      this.lastActionAt = this.deps.now();
      const backgroundCommitted = this.backgroundEventId && this.pending === null && this.state.lastResult?.eventId === this.backgroundEventId;
      if (!backgroundCommitted) this.pending = null;
      this.arrivals = [];
      this.update({ phase: backgroundCommitted ? 'idle' : 'error', source: null, pendingProps: [], readyProps: 0, event: backgroundCommitted ? '小物は届かなかった。完成した背景はそのまま。' : '世界変換エラー。前の世界を維持した。', error: error instanceof Error ? error.message : '世界変換に失敗しました。', ...(typeof attempts === 'number' ? { attempts } : {}) });
    }
  }
  private async receiveBackground(result: WorldResult, request: WorldRequest, serial: number, signal: AbortSignal) {
      if (serial !== this.serial) return;
      if (result.eventId !== request.eventId || result.sessionGeneration !== this.state.generation || result.baseRevision !== request.world.revision || this.state.world.revision !== this.expectedRevision) throw new Error('世界の版が一致しません。');
      if (!isWorldState(result.world)) throw new Error('世界の応答が不正です。');
      this.update({ attempts: result.attempts });
      if (!result.media) { this.lastActionAt = this.deps.now(); this.update({ phase: 'idle', source: null, event: '', lastResult: result }); return; }
      if (result.media.kind !== 'image' || !result.media.url.startsWith('data:image/png;base64,')) throw new Error('画像形式が不正です。');
      await this.deps.loadImage(result.media.url, signal);
      if (serial !== this.serial) return;
      this.pending = result;
      this.update({ phase: 'ready' });
  }
  commit = () => {
    const result = this.pending;
    if (!result || result.sessionGeneration !== this.state.generation || this.state.world.revision !== this.expectedRevision) return false;
    this.pending = null;
    let world = result.world;
    if (this.earlyArrivals.length) {
      world = { ...world, props: [...world.props], creatures: [...world.creatures], sceneElements: [...(world.sceneElements ?? [])], recentEvents: [...new Set([...world.recentEvents, ...this.state.world.recentEvents])].slice(-6), revision: Math.max(world.revision, this.state.world.revision) + 1 };
      for (const a of this.earlyArrivals) this.mergeArrival(world, a);
    }
    this.expectedRevision = world.revision;
    this.lastActionAt = this.deps.now();
    this.update({ world, observation: result.observation, imageUrl: result.media!.url, phase: 'idle', source: null, event: `${result.mutation.action} / ${result.mutation.sideEffect}`, lastResult: result, displayedAt: this.deps.now(), reactionStartedAt: null, ...(this.earlyArrivals.length ? {} : { propObservation: emptyObservation(), propDisplayedAt: null, propReactionStartedAt: null }), presenceShownAt: null });
    return true;
  };
  commitProps = () => {
    const early = this.progressive && (this.state.phase === 'pending' || this.state.phase === 'ready');
    if (!this.arrivals.length || (!early && (this.state.phase !== 'idle' || this.state.displayedAt === null || this.deps.now() - this.state.displayedAt < 300))) return false;
    const arrivals = this.arrivals.splice(0).filter(a => a.eventId === this.backgroundEventId && a.backgroundRevision === this.backgroundRevision && a.sessionGeneration === this.state.generation);
    const world = { ...this.state.world, props: [...this.state.world.props], creatures: [...this.state.world.creatures], sceneElements: [...(this.state.world.sceneElements ?? [])] };
    const visible: string[] = [];
    for (const a of arrivals) {
      const candidate = { ...world, [a.category]: [...world[a.category].filter(e => e.id !== a.entity.id), a.entity] };
      if (!foregroundPlacements(candidate, this.state.layout).some(p => p.entity.id === a.entity.id)) continue;
      world[a.category] = [...world[a.category].filter(e => e.id !== a.entity.id), a.entity];
      if (early) {
        this.earlyArrivals.push(a);
        // Keep provenance and reinforcement time, but not descriptions of the future background.
        const description = a.entity.image!.observation.visible.join('、').slice(0, 240) || a.entity.label;
        this.mergeArrival(world, { ...a, scene: a.scene ? { ...a.scene, baseDescription: description, distantDescription: description, modifiers: [], removedModifierCardIds: [] } : null });
      }
      else this.mergeArrival(world, a);
      visible.push(...a.entity.image!.observation.visible);
      world.nextInterest = a.entity.label; world.nextInterestTargetId = a.entity.id;
    }
    arrivals.forEach(a => this.settledProps.add(a.entity.id));
    const pendingProps = this.state.pendingProps.filter(p => !arrivals.some(a => a.entity.id === p.entityId));
    if (!visible.length) { this.update({ pendingProps, readyProps: 0 }); return false; }
    world.revision++; this.expectedRevision = world.revision;
    world.recentEvents = [...world.recentEvents, `小物が見えるようになった：${visible.join('、')}`.slice(0, 240)].slice(-6);
    this.lastActionAt = this.deps.now();
    this.update({ world, pendingProps, readyProps: 0, propObservation: { available: true, visible: visible.slice(0, 12), uncertain: [], differences: [] }, propDisplayedAt: this.deps.now(), propReactionStartedAt: null, event: `今届いた小物を確認した：${visible.join('、')}`.slice(0, 240) });
    return true;
  };
  private mergeArrival(world: WorldState, a: PropArrival) {
    world[a.category] = [...world[a.category].filter(e => e.id !== a.entity.id), a.entity];
    if (a.scene) {
      const old = world.sceneElements?.find(s => s.id === a.scene!.id);
      const merged = old ? { ...a.scene, entityIds: [...new Set([...old.entityIds, ...a.scene.entityIds])], entities: [...old.entities.filter(e => e.id !== a.entity.id), ...a.scene.entities] } : a.scene;
      world.sceneElements = [...(world.sceneElements ?? []).filter(s => s.id !== merged.id), merged];
    }
  }
  tick = (canAct: boolean, brainCardIds: string[]) => {
    const visibleIds = new Set(foregroundPlacements(this.state.world, this.state.layout).map(p => p.entity.id));
    const target = [...this.state.world.props, ...this.state.world.creatures].find(e => e.id === this.state.world.nextInterestTargetId);
    const driveWorld = target && target.placement !== 'background' && !visibleIds.has(target.id) ? { ...this.state.world, nextInterest: '' } : this.state.world;
    const drive = sampleWorldDrive(driveWorld, this.deps.now(), this.lastActionAt, this.lastInputAt, this.deps.random());
    this.update({ drive, sceneDiagnostics: sceneDiagnostics(this.state.world, { now: this.deps.now(), source: 'autonomous', cardId: null, brainCardIds, cardInsertedAt: this.cardInsertedAt }) });
    if (canAct && drive.eligible && this.state.phase === 'idle' && !this.state.pendingProps.length && this.state.attempts < 20) void this.run('autonomous', null, brainCardIds);
  };
  markReactionStarted = () => {
    if (this.state.propDisplayedAt !== null && this.state.propReactionStartedAt === null) this.update({ propReactionStartedAt: this.deps.now() });
    else if (this.state.displayedAt !== null && this.state.reactionStartedAt === null) this.update({ reactionStartedAt: this.deps.now() });
  };
  dispose = () => { this.serial++; this.controller?.abort(); this.listeners.clear(); };
}
