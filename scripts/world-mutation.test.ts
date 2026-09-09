import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMutation, buildWorldImagePrompt, emptyObservation, initialWorld, isWorldState, parseMutation, worldConversationContext, type MutationEvent, type WorldRequest, type WorldResult } from '../src/world/worldState.js';
import { sceneFreshness, SCENE_BUDGET, normalizeSceneWorld, type SceneContext, type SceneProposal } from '../src/world/worldScene.js';
import { sampleWorldDrive } from '../src/world/worldDrive.js';
import { WorldRuntime } from '../src/world/worldRuntime.js';
import { createWorldProvider, type WorldMediaProvider } from '../server/worldProvider.js';
import { WorldService, parseWorldRequest } from '../server/worldService.js';

const change = (patch: Partial<MutationEvent> = {}): MutationEvent => ({ decision: 'act', type: 'creature', interpretation: '鶏を助け舟にする', action: '鶏を呼んだ', sideEffect: '鶏が増えた', nextInterest: '鶏の背中', location: null, environment: [], props: [], creatures: [{ id: 'chicken', label: '鶏', count: 1, scale: 1, placement: 'right_hand', asset: 'chicken' }], removeEntityIds: [], mood: '愉快', absurdityLevel: 2, ...patch });
const brainCardIds = ['chicken', 'suspicious', 'sleepy', 'rain', 'gigantic'];
const scene = (patch: Partial<SceneProposal> = {}): SceneProposal => ({ id: 'chicken_scene', slot: 'main', entityIds: ['chicken'], sourceCardIds: ['chicken'], baseDescription: '鶏', distantDescription: '遠景の鶏の影', modifiers: [{ cardId: 'gigantic', description: '巨大な姿', scale: 4 }, { cardId: 'underwater', description: '水中を泳ぐ', scale: null }], ...patch });
const sceneContext = (now = 0, patch: Partial<SceneContext> = {}): SceneContext => ({ now, source: 'card', cardId: 'chicken', brainCardIds: ['chicken', 'gigantic', 'underwater', 'sparkle', 'rain'], cardInsertedAt: { chicken: 0, gigantic: 0, underwater: 0 }, ...patch });
const sceneChange = (patch: Partial<MutationEvent> = {}) => change({ sceneChanges: [scene()], nextInterestTargetId: 'chicken_scene', ...patch });
const request = (experimentId: string, patch: Partial<WorldRequest> = {}): WorldRequest => ({ experimentId, sessionGeneration: 0, eventId: randomUUID(), source: 'card', cardId: 'chicken', brainCardIds, world: initialWorld(), ...patch });
const result = (req: WorldRequest): WorldResult => ({ eventId: req.eventId, sessionGeneration: req.sessionGeneration, baseRevision: req.world.revision, mutation: change(), world: applyMutation(req.world, change()), media: { kind: 'image', url: 'data:image/png;base64,AA==' }, observation: { visible: ['青い鶏'], uncertain: [], differences: ['予定より青い'], available: true }, attempts: 1, timing: { receivedAt: 1, plannedAt: 2, generatedAt: 3, observedAt: 4 } });
const provider = (patch: Partial<WorldMediaProvider> = {}): WorldMediaProvider => ({ plan: async () => change(), generate: async () => 'data:image/png;base64,AA==', observe: async () => emptyObservation(), ...patch });
function temporary() { const root = mkdtempSync(join(tmpdir(), 'vayria-world-')); return { root, clean: () => rmSync(root, { recursive: true, force: true }) }; }
function client(post?: (path: string, value: unknown, signal: AbortSignal) => Promise<unknown>, loadImage = async () => {}) {
  let now = 100000;
  const runtime = new WorldRuntime({ post: post ?? (async (_path, req) => result(req as WorldRequest)), loadImage, now: () => now, id: randomUUID, random: () => 0.5, readExperiment: randomUUID, saveExperiment: () => {} });
  return { runtime, advance: (ms: number) => { now += ms; } };
}
test('world accumulates contradictory environments and preserves previous entities', () => {
  const underwater = applyMutation(initialWorld(), change({ location: '海底', environment: ['水中'], creatures: [] }));
  const chicken = applyMutation(underwater, change());
  const giant = applyMutation(chicken, change({ creatures: [{ ...chicken.creatures[0], count: 5, scale: 4 }], environment: ['火の雨'] }));
  assert.equal(giant.location, '海底'); assert.deepEqual(giant.environment, ['水中', '火の雨']);
  assert.equal(giant.creatures.length, 1); assert.equal(giant.creatures[0].count, 5);
  assert.equal(applyMutation(giant, change({ creatures: [], props: [], type: 'prop' })).creatures[0].scale, 4);
});
test('invalid mutation and request are rejected before use', () => {
  assert.throws(() => parseMutation({ ...change(), absurdityLevel: Infinity }));
  assert.throws(() => parseMutation({ ...change(), creatures: [{ ...change().creatures[0], count: -1 }] }));
  assert.throws(() => parseWorldRequest(request('../../secret')));
  assert.throws(() => parseWorldRequest(request(randomUUID(), { brainCardIds: ['chicken'] })));
});

test('conversation contains bounded observations and the actual foreground copy limit', () => {
  const world = applyMutation(initialWorld(), change());
  world.creatures[0].count = 100;
  const context = worldConversationContext(world, { available: true, visible: Array(12).fill('a'.repeat(240)), uncertain: [], differences: [] }, 'idle', 'displayed');
  assert.ok(context.length <= 12000);
  const parsed = JSON.parse(context);
  assert.equal(parsed.renderedForeground[0].visibleCopies, 3);
  assert.equal(parsed.displayedWorld.creatures[0].count, 100);
  assert.equal(parsed.observedImage.visible.length, 4);
});
test('ready image does not commit or leak future world before reveal', async () => {
  const { runtime } = client();
  await runtime.card('chicken', brainCardIds);
  assert.equal(runtime.getSnapshot().phase, 'ready'); assert.equal(runtime.getSnapshot().world.revision, 0); assert.equal(runtime.getSnapshot().imageUrl, null);
  const s = runtime.getSnapshot();
  assert.ok(!worldConversationContext(s.world, s.observation, s.phase, s.event).includes('青い鶏'));
  assert.equal(runtime.commit(), true); assert.equal(runtime.commit(), false);
  assert.equal(runtime.getSnapshot().world.revision, 1); assert.equal(runtime.getSnapshot().observation.visible[0], '青い鶏');
});
test('reset discards delayed generation, observations and image', async () => {
  let finish!: (v: unknown) => void;
  let sent!: WorldRequest;
  const { runtime } = client(async (_path, req) => { sent = req as WorldRequest; return new Promise(resolve => { finish = resolve; }); });
  const pending = runtime.card('chicken', brainCardIds);
  runtime.reset(); finish(result(sent)); await pending;
  assert.equal(runtime.getSnapshot().world.revision, 0); assert.equal(runtime.getSnapshot().phase, 'idle'); assert.equal(runtime.commit(), false);
});
test('cancel during image decoding cannot reveal stale media', async () => {
  let decode!: () => void;
  const { runtime } = client(undefined, () => new Promise(resolve => { decode = resolve; }));
  const pending = runtime.card('chicken', brainCardIds);
  await new Promise(resolve => setTimeout(resolve, 0)); runtime.cancel(); decode(); await pending;
  assert.equal(runtime.commit(), false); assert.equal(runtime.getSnapshot().imageUrl, null);
});
test('wrong revision yields a recoverable error', async () => {
  const { runtime } = client(async (_path, req) => ({ ...result(req as WorldRequest), baseRevision: 9 }));
  await runtime.card('chicken', brainCardIds);
  assert.equal(runtime.getSnapshot().phase, 'error'); assert.equal(runtime.getSnapshot().world.revision, 0);
});
test('failure preserves displayed world and retry can succeed', async () => {
  let fail = false;
  const { runtime } = client(async (_path, req) => { if (fail) throw Object.assign(new Error('offline'), { attempts: 2 }); return result(req as WorldRequest); });
  await runtime.card('chicken', brainCardIds); runtime.commit(); fail = true;
  await runtime.card('gigantic', brainCardIds);
  assert.equal(runtime.getSnapshot().world.revision, 1); assert.equal(runtime.getSnapshot().attempts, 2);
  fail = false; await runtime.retry(); assert.equal(runtime.commit(), true); assert.equal(runtime.getSnapshot().world.revision, 2);
});
test('action drive rises and falls, has a refractory period, and needs a target', () => {
  const world = applyMutation(initialWorld(), change());
  const samples = Array.from({ length: 100 }, (_, i) => sampleWorldDrive(world, i * 1000, -100000, 0, .5));
  assert.ok(samples.some((v, i) => i > 0 && v.score < samples[i - 1].score));
  assert.ok(samples.some((v, i) => i > 0 && v.score > samples[i - 1].score));
  assert.ok(samples.some(v => v.eligible));
  assert.equal(sampleWorldDrive(world, 9000, 0, 0, 1).eligible, false);
  assert.equal(sampleWorldDrive(initialWorld(), 1e9, 0, 0, 1).eligible, false);
});
test('tick does not call provider while shared execution gate is closed', async () => {
  let calls = 0;
  const { runtime, advance } = client(async (_path, req) => { calls++; return result(req as WorldRequest); });
  await runtime.card('chicken', brainCardIds); runtime.commit();
  for (let i = 0; i < 100; i++) { advance(1000); runtime.tick(false, brainCardIds); }
  assert.equal(calls, 1);
});
test('ledger prevents duplicate generation and survives service restart', async () => {
  const temp = temporary();
  try {
    let generated = 0;
    const p = provider({ generate: async () => { generated++; return 'image'; } });
    const service = new WorldService(temp.root, p);
    const experiment = service.createExperiment(); const req = request(experiment.experimentId);
    await service.mutate(req, new AbortController().signal);
    const restarted = new WorldService(temp.root, p);
    await assert.rejects(restarted.mutate(req, new AbortController().signal), /処理済み/);
    assert.equal(generated, 1);
    for (let i = 1; i < 20; i++) await restarted.mutate(request(experiment.experimentId), new AbortController().signal);
    await assert.rejects(restarted.mutate(request(experiment.experimentId, { sessionGeneration: 7 }), new AbortController().signal), /上限20/);
    await restarted.mutate(request(restarted.createExperiment().experimentId), new AbortController().signal);
    assert.equal(generated, 21);
  } finally { temp.clean(); }
});
test('failed image attempts consume budget; failed planning does not', async () => {
  const temp = temporary();
  try {
    const service = new WorldService(temp.root, provider({ generate: async () => { throw new Error('image failed'); } }));
    const id = service.createExperiment().experimentId;
    await assert.rejects(service.mutate(request(id), new AbortController().signal), (error: unknown) => (error as { attempts: number }).attempts === 1);
    const failedPlan = new WorldService(temp.root, provider({ plan: async () => { throw new Error('plan failed'); } }));
    await assert.rejects(failedPlan.mutate(request(id), new AbortController().signal), (error: unknown) => (error as { attempts: number }).attempts === 1);
  } finally { temp.clean(); }
});
test('card cancels autonomous work on server without refunding its image attempt', async () => {
  const temp = temporary();
  try {
    let generating!: () => void;
    const started = new Promise<void>(resolve => { generating = resolve; });
    let calls = 0;
    const p = provider({ generate: async (_world, signal) => { calls++; if (calls > 1) return 'image'; generating(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
    const service = new WorldService(temp.root, p); const id = service.createExperiment().experimentId;
    const first = service.mutate(request(id, { source: 'autonomous', cardId: null }), new AbortController().signal);
    const rejected = assert.rejects(first, /aborted/); await started;
    const second = await service.mutate(request(id), new AbortController().signal);
    await rejected; assert.equal(second.attempts, 2);
  } finally { temp.clean(); }
});
test('provider uses real image endpoint, image input, and preserves observation failure', async () => {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const p = createWorldProvider('test-key', (async (url, init) => {
    urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
    if (String(url).endsWith('images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] }));
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch);
  const image = await p.generate(initialWorld(), new AbortController().signal);
  const observation = await p.observe(image, initialWorld(), new AbortController().signal);
  assert.equal(urls[0], 'https://api.openai.com/v1/images/generations'); assert.equal(bodies[0].n, 1); assert.equal(bodies[0].quality, 'medium');
  assert.ok(JSON.stringify(bodies[1]).includes('input_image')); assert.equal(observation.available, false);
});

test('composite decays one step per reveal, weakest support peels off, then retires', () => {
  const full = applyMutation(initialWorld(), sceneChange(), sceneContext());
  assert.equal(full.creatures[0].scale, 4);
  const neutral = sceneChange({ sceneChanges: [], creatures: [], nextInterestTargetId: 'chicken_scene' });
  const ctx = sceneContext(200000, { cardId: 'rain', brainCardIds: ['chicken', 'underwater', 'rain', 'sparkle', 'sleepy'] });
  const simple = applyMutation(full, neutral, ctx);
  assert.equal(simple.sceneElements?.find(e => e.id === 'chicken_scene')?.stage, 'simple');
  assert.equal(simple.creatures[0].scale, 1);
  assert.ok(!buildWorldImagePrompt(simple).includes('巨大な姿'));
  assert.equal(full.creatures[0].scale, 4, 'original display remains immutable');
  const distant = applyMutation(simple, neutral, { ...ctx, now: 900000 });
  assert.equal(distant.sceneElements?.find(e => e.id === 'chicken_scene')?.stage, 'distant');
  assert.equal(distant.creatures[0].asset, 'none');
  const retired = applyMutation(distant, neutral, { ...ctx, now: 901000 });
  assert.equal(retired.creatures.length, 0);
  assert.equal(retired.nextInterest, '');
  assert.ok(retired.recentEvents.some(e => e.includes('画面外')));
  assert.ok(!buildWorldImagePrompt(retired).includes('鶏'));
  assert.ok(worldConversationContext(retired, emptyObservation(), 'idle', '').includes('鶏'));
  assert.ok(isWorldState(retired));
});

test('all card support still decays; removal alone does not instantly erase', () => {
  const world = applyMutation(initialWorld(), sceneChange(), sceneContext());
  const e = world.sceneElements!.find(e => e.id === 'chicken_scene')!;
  const original = sceneFreshness(e, world.sceneElements!, sceneContext());
  assert.ok(sceneFreshness(e, world.sceneElements!, sceneContext(180000)) <= original / 2);
  const removed = applyMutation(world, sceneChange({ creatures: [], sceneChanges: [] }), sceneContext(1000, { cardId: 'rain', brainCardIds: [] }));
  assert.equal(removed.creatures.length, 1);
});

test('budgets retire older groups and composites count only once', () => {
  let world = applyMutation(initialWorld(), sceneChange(), sceneContext());
  for (let i = 1; i <= 7; i++) {
    const id = `bird_${i}`;
    world = applyMutation(world, sceneChange({ creatures: [{ ...change().creatures[0], id }], sceneChanges: [scene({ id: `scene_${i}`, entityIds: [id] })] }), sceneContext(i * 1000, { cardInsertedAt: { chicken: i * 1000, gigantic: 0, underwater: 0 } }));
    assert.ok(isWorldState(world));
  }
  const active = world.sceneElements!.filter(e => e.stage !== 'retired');
  for (const slot of Object.keys(SCENE_BUDGET) as (keyof typeof SCENE_BUDGET)[]) assert.ok(active.filter(e => e.slot === slot).length <= SCENE_BUDGET[slot]);
  assert.deepEqual(world.creatures.map(e => e.id).sort(), ['bird_6', 'bird_7']);
  assert.equal(new Set(active.flatMap(e => e.entityIds)).size, 2);
});

test('repeat card revives same entity; autonomous references cannot revive retired entity', () => {
  const first = applyMutation(initialWorld(), sceneChange(), sceneContext());
  const retiring = sceneChange({ creatures: [], sceneChanges: [], removeEntityIds: ['chicken'] });
  const retired = applyMutation(first, retiring, sceneContext(1000));
  assert.throws(() => applyMutation(retired, sceneChange(), sceneContext(2000, { source: 'autonomous', cardId: null })), /再登場/);
  const revived = applyMutation(retired, sceneChange(), sceneContext(2000, { cardInsertedAt: { chicken: 2000 } }));
  assert.equal(revived.creatures.length, 1);
  assert.equal(revived.sceneElements!.filter(e => e.entityIds.includes('chicken')).length, 1);
  assert.equal(revived.sceneElements!.find(e => e.id === 'chicken_scene')!.stage, 'detailed');
});

test('invalid references, duplicate ownership and untracked updates are rejected', () => {
  assert.throws(() => applyMutation(initialWorld(), sceneChange({ sceneChanges: [scene({ entityIds: ['missing'] })] }), sceneContext()), /参照/);
  assert.throws(() => applyMutation(initialWorld(), sceneChange({ sceneChanges: [scene({ sourceCardIds: ['invented'] })] }), sceneContext()), /参照/);
  assert.throws(() => applyMutation(initialWorld(), sceneChange({ sceneChanges: [] }), sceneContext()), /情景/);
  const first = applyMutation(initialWorld(), sceneChange(), sceneContext());
  assert.throws(() => applyMutation(first, sceneChange({ sceneChanges: [scene({ id: 'duplicate' })] }), sceneContext()), /同じ情景ID/);
  assert.throws(() => parseMutation(sceneChange({ sceneChanges: [scene({ modifiers: [{ cardId: 'gigantic', description: '巨大', scale: 99 }] })] })), /情景/);
});

test('observations and unchanged autonomous proposals never refresh timestamps', () => {
  const first = applyMutation(initialWorld(), sceneChange(), sceneContext());
  const after = applyMutation(first, sceneChange(), sceneContext(100000, { source: 'autonomous', cardId: null }));
  assert.equal(after.sceneElements!.find(e => e.id === 'chicken_scene')!.lastReinforcedAt, 0);
  worldConversationContext(after, { visible: ['鶏'], uncertain: [], differences: [], available: true }, 'idle', '');
  assert.equal(after.sceneElements!.find(e => e.id === 'chicken_scene')!.lastReinforcedAt, 0);
});

test('retry preserves insertion time and only a real swap refreshes it', async () => {
  const sent: WorldRequest[] = [];
  const { runtime, advance } = client(async (_path, req) => { sent.push(req as WorldRequest); throw new Error('offline'); });
  await runtime.card('chicken', brainCardIds); advance(180000); await runtime.retry();
  assert.equal(sent[0].cardInsertedAt!.chicken, sent[1].cardInsertedAt!.chicken);
  await runtime.card('chicken', brainCardIds);
  assert.ok(sent[2].cardInsertedAt!.chicken > sent[1].cardInsertedAt!.chicken);
  runtime.reset(); await runtime.card('gigantic', brainCardIds);
  assert.equal(sent[3].cardInsertedAt!.chicken, sent[3].cardInsertedAt!.gigantic, 'initial brain timestamps restart with the session');
});

test('legacy migration has unknown provenance; image never receives archives or intentions', () => {
  const old = applyMutation(initialWorld(), change());
  old.recentEvents = ['MEMORY_SECRET']; old.nextInterest = 'INTENTION_SECRET';
  const normalized = normalizeSceneWorld(old, 120000);
  assert.ok(normalized.sceneElements!.every(e => e.sourceCardIds.length === 0));
  const prompt = buildWorldImagePrompt(normalized);
  assert.ok(!prompt.includes('MEMORY_SECRET') && !prompt.includes('INTENTION_SECRET') && !prompt.includes('sceneElements'));
  assert.equal(normalized.revision, old.revision);
});

test('retirement commits atomically with the decoded image and none never decays', async () => {
  let retire = false;
  const { runtime } = client(async (_path, req) => {
    const request = req as WorldRequest;
    const mutation = retire ? sceneChange({ creatures: [], sceneChanges: [], removeEntityIds: ['chicken'] }) : sceneChange({ sceneChanges: [scene({ modifiers: [] })] });
    const next = applyMutation(request.world, mutation, sceneContext(100000, { brainCardIds, cardInsertedAt: request.cardInsertedAt ?? {} }));
    return { ...result(request), mutation, world: next };
  });
  await runtime.card('chicken', brainCardIds); runtime.commit();
  retire = true;
  await runtime.card('rain', brainCardIds);
  const ready = runtime.getSnapshot();
  assert.equal(ready.world.creatures.length, 1);
  assert.ok(!worldConversationContext(ready.world, ready.observation, ready.phase, ready.event).includes('画面外'));
  runtime.cancel(); assert.equal(runtime.getSnapshot().world.creatures.length, 1);
  await runtime.retry(); runtime.commit();
  assert.equal(runtime.getSnapshot().world.creatures.length, 0);
  const world = runtime.getSnapshot().world;
  assert.equal(applyMutation(world, sceneChange({ decision: 'none' }), sceneContext(99999999)), world);
});

test('effect assets share the two effect slots and malformed modifiers are rejected', () => {
  const props = [1, 2, 3].map(i => ({ id: `spark_${i}`, label: 'きらきら', count: 5, scale: 1, placement: 'foreground' as const, asset: 'spark' as const }));
  const sceneChanges = props.map(e => scene({ id: `scene_${e.id}`, slot: 'effect', entityIds: [e.id], sourceCardIds: ['sparkle'], baseDescription: 'きらきら', distantDescription: '遠い光', modifiers: [] }));
  const world = applyMutation(initialWorld(), sceneChange({ creatures: [], props, sceneChanges }), sceneContext(0, { cardId: 'sparkle', cardInsertedAt: { sparkle: 0 } }));
  assert.equal(world.props.length, 2);
  assert.equal(world.environment.length, 2);
  assert.ok(isWorldState(world));
  assert.throws(() => parseMutation({ ...sceneChange(), sceneChanges: [{ ...scene(), modifiers: [null] }] }), /情景の形式/);
});
