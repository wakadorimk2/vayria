import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fallbackLayout, imageRectToScreen, isWorldLayout, overlaps, placeWorldProp, screenRectToImage } from '../src/world/worldLayout.js';
import { WORLD_PROP_ASSETS, foregroundPlacements } from '../src/world/worldProps.js';
import { omitWorldEntities, type PropArrival, type WorldStreamEvent } from '../src/world/worldProps.js';
import { applyMutation, buildWorldImagePrompt, initialWorld, worldConversationContext, type MutationEvent, type WorldRequest, type WorldResult } from '../src/world/worldState.js';
import { WorldRuntime, type WorldRuntimeDependencies } from '../src/world/worldRuntime.js';
import { createWorldGuide, inspectPropPng, propCacheKey, WorldAssetCache } from '../server/worldAssets.js';
import { WorldService } from '../server/worldService.js';
import { createWorldProvider, type WorldMediaProvider } from '../server/worldProvider.js';

const brain = ['chicken', 'suspicious', 'sleepy', 'rain', 'gigantic'];
const mutation = (unknown = false): MutationEvent => ({ decision: 'act', type: 'prop', interpretation: '小物が現れる', action: '小物を呼ぶ', sideEffect: '未知の副作用', nextInterest: '小物', location: '海底', environment: [], creatures: [], props: [{ id: 'subject', label: unknown ? '魔法のカップ' : '鶏', count: 1, scale: 1, placement: 'right_hand', asset: unknown ? 'generated' : 'chicken', propSpec: unknown ? { subject: 'cup', shape: 'star handle', orientation: 'front' } : null }], removeEntityIds: [], mood: '愉快', absurdityLevel: 2 });
const request = (experimentId: string = randomUUID()): WorldRequest => ({ experimentId, eventId: randomUUID(), sessionGeneration: 0, source: 'card', cardId: 'chicken', brainCardIds: brain, world: initialWorld(), layout: fallbackLayout() });
const png = 'data:image/png;base64,' + readFileSync('public/world/egg-painted.png').toString('base64');
const observation = { available: true, visible: ['白い小物'], uncertain: [], differences: [] };
const provider = (patch: Partial<WorldMediaProvider> = {}): WorldMediaProvider => ({ plan: async () => mutation(), generate: async () => png, observe: async () => observation, ...patch });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'vayria-presentation-')); return { root, close: () => rmSync(root, { recursive: true, force: true }) }; };

test('cover coordinates round trip after resize, portrait and landscape, including adjusted regions', () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }, { width: 700, height: 700 }]) {
    for (const rect of [fallbackLayout().body, { x: .2, y: .31, width: .24, height: .35 }]) {
      const restored = imageRectToScreen(screenRectToImage(rect, viewport), viewport);
      for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(restored[key] - rect[key]) < 1e-12);
    }
  }
  assert.equal(isWorldLayout({ ...fallbackLayout(), width: Infinity }), false);
});
test('placement respects alpha bounds, pivot, exclusions and rejects impossible hand position', () => {
  const layout = { ...fallbackLayout(), obstacles: [], rightHand: { x: .8, y: .8 } };
  const asset = WORLD_PROP_ASSETS.chicken;
  const placed = placeWorldProp(layout, layout.rightHand, asset)!;
  assert.ok(placed); assert.equal(overlaps(placed.visible, layout.face), false);
  assert.ok(Math.abs(placed.rect.x + placed.rect.width * asset.pivot.x - layout.rightHand.x) < 1e-9);
  assert.equal(placeWorldProp({ ...layout, obstacles: [{ x: 0, y: 0, width: 1, height: 1 }] }, layout.rightHand, asset), null);
});
test('all bundled PNGs are transparent, unclipped, and manifest contains the visible silhouette', async () => {
  for (const name of ['chicken', 'egg', 'feather', 'bat']) {
    const { bounds } = await inspectPropPng(readFileSync(`public/world/${name}-painted.png`));
    const declared = WORLD_PROP_ASSETS[name].bounds;
    assert.ok(bounds.x >= declared.x && bounds.y >= declared.y && bounds.x + bounds.width <= declared.x + declared.width && bounds.y + bounds.height <= declared.y + declared.height, name);
    const tiny = await sharp(`public/world/${name}-painted.png`).resize(96, 96).raw().toBuffer();
    assert.ok(tiny.some(byte => byte !== 0));
  }
  const opaque = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(inspectPropPng(opaque), /透過/);
  const clipped = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00000000' } }).composite([{ input: Buffer.from('<svg width="16" height="16"><rect width="8" height="8" fill="red"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
  await assert.rejects(inspectPropPng(clipped), /切れ/);
});
test('guide is a PNG and provider sends a reference edit plus official transparent prop settings', async () => {
  const guide = await createWorldGuide(fallbackLayout());
  assert.equal((await sharp(guide).metadata()).width, 1536);
  const calls: { url: string; body: unknown }[] = [];
  const fake: typeof fetch = async (url, init) => {
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)); calls.push({ url: String(url), body });
    return new Response(JSON.stringify(String(url).endsWith('responses') ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ suitable: true, ...observation }) }] }] } : { data: [{ b64_json: png.split(',')[1] }] }), { status: 200 });
  };
  const p = createWorldProvider('test', fake);
  await p.generate(initialWorld(), new AbortController().signal, fallbackLayout());
  assert.ok(calls[0].url.endsWith('/images/edits')); assert.ok((calls[0].body as FormData).get('image[]'));
  await p.generateProp!(mutation(true).props[0].propSpec!, new AbortController().signal);
  assert.equal((calls[1].body as { background: string }).background, 'transparent');
  assert.equal((calls[1].body as { quality: string }).quality, 'high');
});

function streamingClient() {
  let now = 10000, receive!: (event: WorldStreamEvent) => Promise<void>, sent!: WorldRequest, finish!: () => void, fail!: (error: Error) => void;
  const deps: WorldRuntimeDependencies = { now: () => now, id: randomUUID, random: () => .5, readExperiment: randomUUID, saveExperiment: () => {}, post: async () => ({}), loadImage: async () => {}, stream: async (req, _signal, callback) => { sent = req; receive = callback; await new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }); } };
  const runtime = new WorldRuntime(deps);
  runtime.setLayout({ ...fallbackLayout(), obstacles: [], rightHand: { x: .8, y: .8 } });
  return { runtime, start: () => runtime.card('chicken', brain), advance: (ms: number) => { now += ms; }, send: (e: WorldStreamEvent) => receive(e), end: () => finish(), fail: (error: Error) => fail(error), events: () => {
    const world = applyMutation(sent.world, mutation());
    const result: WorldResult = { eventId: sent.eventId, sessionGeneration: sent.sessionGeneration, baseRevision: sent.world.revision, mutation: { ...mutation(), action: '背景が変わった', sideEffect: '' }, world: omitWorldEntities(world, new Set(['subject'])), media: { kind: 'image', url: png }, observation, attempts: 1, timing: { receivedAt: 1, plannedAt: 2, generatedAt: 3, observedAt: 4 } };
    result.world.recentEvents = [];
    const arrival: PropArrival = { eventId: sent.eventId, sessionGeneration: sent.sessionGeneration, backgroundRevision: world.revision, entity: { ...world.props[0], image: WORLD_PROP_ASSETS.chicken }, scene: null, category: 'props', attempts: 1 };
    return { background: { type: 'background' as const, result, pending: [{ entityId: 'subject', placement: 'right_hand' as const, prominent: true }] }, prop: { type: 'prop' as const, arrival } };
  } };
}
test('decoded prop waits for background, speech gate and 300ms; arrival commits exactly once without future facts', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  await c.send(e.background); await c.send(e.prop);
  assert.equal(c.runtime.commitProps(), false); assert.equal(c.runtime.getSnapshot().world.props.length, 0);
  c.runtime.commit(); assert.equal(c.runtime.commitProps(), false);
  const s = c.runtime.getSnapshot();
  const context = JSON.parse(worldConversationContext(s.world, s.observation, s.phase, s.event, s.propObservation, s.pendingProps.length));
  assert.equal(context.displayedWorld.props.length, 0); assert.equal(context.renderedForeground.length, 0);
  c.advance(300); assert.equal(c.runtime.commitProps(), true); assert.equal(c.runtime.commitProps(), false);
  await c.send(e.prop); assert.equal(c.runtime.getSnapshot().readyProps, 0);
  assert.equal(c.runtime.getSnapshot().world.props.length, 1);
  c.runtime.markReactionStarted(); const time = c.runtime.getSnapshot().propReactionStartedAt;
  c.advance(200); c.runtime.markReactionStarted(); assert.equal(c.runtime.getSnapshot().propReactionStartedAt, time);
  c.end(); await task;
});
test('long prop wait never becomes a fact; reset, cancellation and next card discard late arrivals', async () => {
  for (const operation of ['reset', 'cancel', 'card'] as const) {
    const c = streamingClient(), task = c.start(), e = c.events();
    await c.send(e.background); c.runtime.commit(); c.advance(120000);
    assert.equal(c.runtime.getSnapshot().world.props.length, 0);
    const oldSend = c.send; // callback itself is replaced by a new request, but event identity remains old.
    c.end(); await task;
    let next: Promise<void> | undefined;
    if (operation === 'card') next = c.start(); else c.runtime[operation]();
    await oldSend(e.prop); assert.equal(c.runtime.commitProps(), false);
    assert.equal(c.runtime.getSnapshot().world.props.length, 0);
    if (next) { c.end(); await next; }
  }
});
test('prop failure retains completed background and removes only its placeholder', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  await c.send(e.background); c.runtime.commit();
  await c.send({ type: 'prop_error', eventId: e.prop.arrival.eventId, entityId: 'subject', error: '検査失敗', attempts: 2 });
  assert.equal(c.runtime.getSnapshot().imageUrl, png); assert.equal(c.runtime.getSnapshot().pendingProps.length, 0);
  assert.equal(c.runtime.getSnapshot().world.props.length, 0); c.end(); await task;
});
test('uncached prop and background run concurrently, reserve two; cache and remaining one respect budget', async () => {
  const temp = temporary();
  try {
    let bgStarted = false, propStarted = false, propCalls = 0;
    const service = new WorldService(temp.root, provider({ plan: async () => mutation(true), generate: async () => { bgStarted = true; assert.ok(propStarted); return png; }, generateProp: async () => { propStarted = true; propCalls++; await Promise.resolve(); assert.ok(bgStarted); return { image: png, observation }; } }));
    const experiment = service.createExperiment(); const events: WorldStreamEvent[] = [];
    await service.mutate(request(experiment.experimentId), new AbortController().signal, e => events.push(e));
    assert.equal(events[0].type, 'planned'); assert.equal(events.at(-1)?.type, 'done');
    assert.equal((events.find(e => e.type === 'background') as { result: WorldResult }).result.attempts, 2);
    assert.equal((events.find(e => e.type === 'background') as { result: WorldResult }).result.world.props.length, 0);
    await service.mutate(request(experiment.experimentId), new AbortController().signal, () => {});
    assert.equal(propCalls, 1);
    const cache = new WorldAssetCache(join(temp.root, 'assets'));
    assert.ok(cache.read(mutation(true).props[0].propSpec!));
    const second = service.createExperiment(); writeFileSync(join(temp.root, second.experimentId + '.json'), JSON.stringify({ attempts: 19, events: [] }));
    const uncache = new WorldService(temp.root, provider({ plan: async () => { const m = mutation(true); m.props[0].propSpec!.shape = 'different'; return m; }, generateProp: async () => { throw new Error('must not call'); } }));
    const last = await uncache.mutate(request(second.experimentId), new AbortController().signal, () => {});
    assert.equal(last.attempts, 20); assert.equal(last.world.props[0].placement, 'background');
    await assert.rejects(uncache.mutate(request(second.experimentId), new AbortController().signal, () => {}), /20/);
  } finally { temp.close(); }
});
test('cache key depends on shape and direction, not size; image prompt excludes foreground, memories and pending objects', () => {
  const a = { subject: 'cup', shape: 'star', orientation: 'front' as const };
  assert.equal(propCacheKey(a), propCacheKey({ ...a })); assert.notEqual(propCacheKey(a), propCacheKey({ ...a, shape: 'round' }));
  const world = applyMutation(initialWorld(), mutation()); world.recentEvents = ['SECRET_HISTORY']; world.nextInterest = 'SECRET_INTENT';
  const prompt = buildWorldImagePrompt(world);
  assert.ok(!prompt.includes('鶏')); assert.ok(!prompt.includes('SECRET'));
});

test('failed background publishes no background and does not refund concurrent image reservations', async () => {
  const temp = temporary();
  try {
    const service = new WorldService(temp.root, provider({ plan: async () => mutation(true), generate: async () => { throw new Error('background failed'); }, generateProp: async () => ({ image: png, observation }) }));
    const experiment = service.createExperiment(), events: WorldStreamEvent[] = [];
    await assert.rejects(service.mutate(request(experiment.experimentId), new AbortController().signal, e => events.push(e)), /background failed/);
    assert.ok(events.every(e => e.type === 'planned'));
    assert.equal(JSON.parse(readFileSync(join(temp.root, experiment.experimentId + '.json'), 'utf8')).attempts, 2);
  } finally { temp.close(); }
});
test('failed unknown prop still publishes a valid background and one failure, never an uninspected asset', async () => {
  const temp = temporary();
  try {
    const service = new WorldService(temp.root, provider({ plan: async () => mutation(true), generateProp: async () => { throw new Error('inspection failed'); } }));
    const events: WorldStreamEvent[] = [];
    await service.mutate(request(service.createExperiment().experimentId), new AbortController().signal, e => events.push(e));
    assert.deepEqual(events.map(e => e.type), ['planned', 'prop_error', 'background', 'done']);
  } finally { temp.close(); }
});
test('invalid prop image cannot enter the world after background commit', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  await c.send(e.background); c.runtime.commit(); c.advance(1500);
  await c.send({ ...e.prop, arrival: { ...e.prop.arrival, entity: { ...e.prop.arrival.entity, image: { ...WORLD_PROP_ASSETS.chicken, url: 'https://untrusted.invalid/image.png' } } } });
  assert.equal(c.runtime.getSnapshot().readyProps, 0);
  assert.equal(c.runtime.commitProps(), false);
  c.end(); await task;
});
test('no placement means no prop fact or remaining placeholder', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  await c.send(e.background); await c.send(e.prop); c.runtime.commit();
  c.runtime.setLayout({ ...fallbackLayout(), obstacles: [{ x: 0, y: 0, width: 1, height: 1 }] });
  c.advance(300); assert.equal(c.runtime.commitProps(), false);
  assert.equal(c.runtime.getSnapshot().world.props.length, 0);
  assert.equal(c.runtime.getSnapshot().pendingProps.length, 0);
  c.end(); await task;
});
test('foreground copies remain at most three and conversation uses actual successful placements', () => {
  const world = applyMutation(initialWorld(), mutation()); world.props[0].count = 100;
  const layout = { ...fallbackLayout(), obstacles: [], face: { x: .4, y: .1, width: .2, height: .2 }, rightHand: { x: .8, y: .8 } };
  const placements = foregroundPlacements(world, layout);
  assert.ok(placements.length > 0 && placements.length <= 3);
  for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) assert.equal(overlaps(placements[i].visible, placements[j].visible), false);
  const context = JSON.parse(worldConversationContext(world, observation, 'idle', '', observation, 0, layout));
  assert.equal(context.renderedForeground[0].visibleCopies, placements.length);
  const blocked = JSON.parse(worldConversationContext(world, observation, 'idle', '', observation, 0, { ...layout, obstacles: [{ x: 0, y: 0, width: 1, height: 1 }] }));
  assert.equal(blocked.displayedWorld.props.length, 0);
});
test('late arrival preserves scene reinforcement time and original canonical shape', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  e.prop.arrival.scene = { id: 'chicken-scene', slot: 'main', entityIds: ['subject'], entities: [e.prop.arrival.entity], sourceCardIds: ['chicken'], baseDescription: '鶏', distantDescription: '遠くの影', modifiers: [], lastReinforcedAt: 123, stage: 'detailed', retirementReason: '', removedModifierCardIds: [] };
  await c.send(e.background); c.runtime.commit(); c.advance(120000);
  c.runtime.tick(false, brain);
  await c.send(e.prop); assert.equal(c.runtime.commitProps(), true);
  assert.equal(c.runtime.getSnapshot().world.sceneElements![0].lastReinforcedAt, 123);
  c.end(); await task;
});
test('an already displayed asset survives a new background without another arrival or request', async () => {
  const temp = temporary();
  try {
    const service = new WorldService(temp.root, provider({ plan: async () => mutation() }));
    const req = request(service.createExperiment().experimentId);
    req.world = applyMutation(initialWorld(), mutation());
    req.world.props[0].image = WORLD_PROP_ASSETS.chicken;
    const events: WorldStreamEvent[] = [];
    const result = await service.mutate(req, new AbortController().signal, e => events.push(e));
    assert.deepEqual(events.map(e => e.type), ['planned', 'background', 'done']);
    assert.equal(result.world.props[0].image?.key, WORLD_PROP_ASSETS.chicken.key);
    assert.equal(result.attempts, 1);
  } finally { temp.close(); }
});
test('a foreground egg cannot displace the main chicken; another free side is used', () => {
  const world = applyMutation(initialWorld(), mutation());
  const chicken = { ...world.props[0], placement: 'foreground' as const, scale: 3 };
  world.props = [{ ...chicken, id: 'egg', asset: 'egg', scale: .6 }]; world.creatures = [chicken];
  world.sceneElements = [{ id: 'chicken-scene', slot: 'main', entityIds: [chicken.id], entities: [chicken], sourceCardIds: ['chicken'], baseDescription: '鶏', distantDescription: '影', modifiers: [], lastReinforcedAt: 123, stage: 'detailed', retirementReason: '', removedModifierCardIds: [] }];
  const placed = foregroundPlacements(world, { ...fallbackLayout(), obstacles: [] });
  assert.deepEqual(placed.map(p => p.entity.asset), ['chicken', 'egg']);
  assert.equal(overlaps(placed[0].visible, placed[1].visible), false);
});

function planEvent(e: ReturnType<ReturnType<typeof streamingClient>['events']>): WorldStreamEvent {
  return { type: 'planned', eventId: e.background.result.eventId, sessionGeneration: 0, baseRevision: e.background.result.baseRevision, backgroundRevision: e.prop.arrival.backgroundRevision, pending: e.background.pending, attempts: 1 };
}
test('prop first changes only visible props; later background preserves it and arrival reacts once', async () => {
  const c = streamingClient(), task = c.start(), e = c.events();
  await c.send(planEvent(e)); await c.send(e.prop);
  assert.equal(c.runtime.getSnapshot().world.props.length, 0);
  c.advance(100); assert.equal(c.runtime.commitProps(), true);
  const early = c.runtime.getSnapshot();
  assert.equal(early.imageUrl, null); assert.equal(early.world.location, initialWorld().location);
  assert.equal(early.world.props.length, 1); assert.equal(early.phase, 'pending');
  const context = worldConversationContext(early.world, early.observation, early.phase, early.event, early.propObservation);
  assert.ok(!context.includes('海底')); assert.ok(!context.includes('未知の副作用'));
  c.runtime.markReactionStarted(); const reactedAt = c.runtime.getSnapshot().propReactionStartedAt;
  await c.send(e.background); assert.equal(c.runtime.commit(), true);
  assert.equal(c.runtime.getSnapshot().world.props.length, 1);
  assert.equal(c.runtime.getSnapshot().world.location, '海底');
  assert.equal(c.runtime.getSnapshot().pendingProps.length, 0);
  assert.equal(c.runtime.getSnapshot().propReactionStartedAt, reactedAt);
  await c.send(e.prop); assert.equal(c.runtime.commitProps(), false);
  assert.equal(c.runtime.getSnapshot().world.props.length, 1); c.end(); await task;
});
test('background failure or cancellation preserves an already displayed prop; reset clears it', async () => {
  for (const operation of ['cancel', 'reset', 'failure'] as const) {
    const c = streamingClient(), task = c.start(), e = c.events();
    await c.send(planEvent(e)); await c.send(e.prop); c.runtime.commitProps();
    if (operation === 'failure') { c.fail(new Error('背景失敗')); await task; assert.equal(c.runtime.getSnapshot().phase, 'error'); }
    else c.runtime[operation]();
    assert.equal(c.runtime.getSnapshot().world.props.length, operation === 'reset' ? 0 : 1);
    assert.equal(c.runtime.getSnapshot().imageUrl, null);
    if (operation !== 'failure') { await c.send(e.background); assert.equal(c.runtime.commit(), false); }
    c.end(); await task;
  }
});
test('known prop is emitted while background generation is still waiting', async () => {
  const temp = temporary();
  try {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const events: WorldStreamEvent[] = [];
    const service = new WorldService(temp.root, provider({ generate: async () => { await wait; return png; } }));
    const run = service.mutate(request(service.createExperiment().experimentId), new AbortController().signal, e => events.push(e));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(events.map(e => e.type), ['planned', 'prop']);
    release(); await run;
    assert.deepEqual(events.map(e => e.type), ['planned', 'prop', 'background', 'done']);
  } finally { temp.close(); }
});
test('chest placement ignores offscreen hands and still avoids the face and UI', () => {
  const world = applyMutation(initialWorld(), mutation());
  const layout = { ...fallbackLayout(), obstacles: [], face: { x: .3, y: .1, width: .4, height: .4 }, leftHand: null, rightHand: null };
  const placement = foregroundPlacements(world, layout)[0];
  assert.ok(placement); assert.equal(overlaps(placement.visible, layout.face), false);
  assert.ok(placement.visible.x < .6 && placement.visible.x + placement.visible.width > .4);
});

test('measured narrow portrait layout leaves the chicken between face and subtitle', () => {
  const world = applyMutation(initialWorld(), mutation()); world.props[0].scale = 3.2;
  const layout = { ...fallbackLayout(), width: 390, height: 844, body: { x: 0, y: .107, width: 1, height: .893 }, face: { x: .1, y: .097, width: .75, height: .372 }, obstacles: [ { x: .02, y: .002, width: .96, height: .162 }, { x: .049, y: .726, width: .9, height: .177 }, { x: .075, y: .618, width: .85, height: .062 } ] };
  const p = foregroundPlacements(world, layout)[0]; assert.ok(p);
  assert.ok(p.visible.y >= .469); assert.ok(p.visible.y + p.visible.height <= .618);
  for (const r of [layout.face, ...layout.obstacles]) assert.equal(overlaps(p.visible, r), false);
});
