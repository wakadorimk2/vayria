import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestationSession, manifestationContext } from '../src/manifestation/session.js';
import type { GeneratedObject, InputEvent } from '../src/manifestation/types.js';
import { chooseSlotCard } from '../src/cards/slotCardInsertion.js';
import { cardPool } from '../src/cards/cardPool.js';
import { ManifestationLedger } from '../server/manifestationLedger.js';
import { generateManifestation } from '../server/manifestationProvider.js';
import { keyGreen } from '../src/manifestation/media.js';
import { handleManifestationRequest } from '../server/manifestationHandler.js';
import { createServer } from 'node:http';
import { createMediaTicket, relayMedia, mediaHost } from '../server/manifestationMediaRelay.js';
import { createGenerationTrace } from '../server/manifestationTrace.js';

const media: GeneratedObject = { kind: 'image', url: '/test.png', composite: 'alpha', mode: 'fresh-image', timings: {} };
const event = (id: string, generation = 0): InputEvent => ({ eventId: id, sessionId: 'session', generation, clientId: 'local', cardId: 'chicken' });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup() {
  let now = 0, applied = 0, notices = 0;
  const calls: { resolve(v: GeneratedObject): void; reject(): void; signal: AbortSignal }[] = [];
  const runtime = new ManifestationSession('session', {
    now: () => now, applyCard: () => { applied++; return true; }, displayed: () => notices++,
    fallback: () => ({ ...media, mode: 'static-fallback' }), prepare: async () => {},
    generate: (_event, signal) => new Promise((resolve, reject) => calls.push({ resolve, reject: () => reject(new Error('failure')), signal })),
  });
  return { runtime, calls, time: (value: number) => { now = value; runtime.tick(); }, applied: () => applied, notices: () => notices };
}
test('cancel keeps accepted cards and rejects late results; audio before media is retained only for latest input', async () => {
  const t = setup(); t.runtime.dispatch(event('a')); t.time(100); t.runtime.markAudioStarted();
  t.calls[0].resolve(media); await flush(); t.runtime.markVisible('a', true);
  assert.equal(t.runtime.getSnapshot().telemetry[0].timings?.audioStartedAt, 100);
  assert.equal(t.runtime.getSnapshot().telemetry[0].timings?.firstDisplayedAt, 100);
  t.runtime.dispatch(event('b')); t.runtime.cancelPending();
  assert.equal(t.calls[1].signal.aborted, true); assert.equal(t.runtime.getSnapshot().pending, 0);
  t.calls[1].resolve(media); await flush();
  assert.equal(t.runtime.getSnapshot().objects.length, 1); assert.equal(t.applied(), 2);
});
test('slot reinsertion uses the same brain slot; eviction uses oldest reinforcement and stable ties', () => {
  const brain = ['chicken', 'suspicious', 'sleepy', 'rain', 'gigantic'].map(id => cardPool.find(c => c.id === id)!);
  const repeat = chooseSlotCard(brain, 'chicken', {});
  assert.deepEqual(repeat?.brain, brain); assert.equal(repeat?.reinforced, true);
  assert.equal(chooseSlotCard(brain, 'sparkle', { chicken: 5 })?.ejected.id, 'suspicious');
  assert.equal(chooseSlotCard(brain, 'sparkle', {})?.ejected.id, 'chicken');
  assert.equal(chooseSlotCard(brain, 'invalid', {}), null);
});
test('insertion is immediate; no completed object or observation leaks before reveal', async () => {
  const t = setup(); assert.equal(t.runtime.dispatch(event('a')), true);
  assert.equal(t.runtime.getSnapshot().sequence, 1); assert.equal(t.runtime.getSnapshot().pending, 1);
  assert.equal(t.runtime.getSnapshot().objects.length, 0); assert.equal(t.notices(), 0);
  t.calls[0].resolve(media); await flush();
  assert.equal(t.runtime.getSnapshot().objects.length, 1); assert.equal(t.notices(), 0);
  assert.equal(manifestationContext(t.runtime.getSnapshot()).includes('鶏の小物'), false);
  t.runtime.markVisible('a', true); t.runtime.markVisible('a', true);
  assert.equal(t.notices(), 1);
  assert.equal(manifestationContext(t.runtime.getSnapshot()).includes('鶏の小物'), true);
});
test('duplicate, wrong session, malformed and reset-generation input do not mutate cards', () => {
  const t = setup(); t.runtime.dispatch(event('a'));
  assert.equal(t.runtime.dispatch(event('a')), false);
  assert.equal(t.runtime.dispatch({ ...event('b'), sessionId: 'other' }), false);
  assert.equal(t.runtime.dispatch({ ...event('c'), generation: NaN }), false);
  t.runtime.reset(); assert.equal(t.runtime.dispatch(event('d')), false);
  assert.equal(t.applied(), 1);
});
test('five seconds commits fallback, ten seconds aborts, late media never replaces it', async () => {
  const t = setup(); t.runtime.dispatch(event('a')); t.time(4999);
  assert.equal(t.runtime.getSnapshot().objects.length, 0);
  t.time(5000); assert.equal(t.runtime.getSnapshot().objects[0].mode, 'static-fallback');
  t.time(10000); assert.equal(t.calls[0].signal.aborted, true);
  t.calls[0].resolve(media); await flush();
  assert.equal(t.runtime.getSnapshot().objects[0].mode, 'static-fallback');
});
test('two active requests, one waiting; overflow completes oldest waiter without undoing its card', async () => {
  const t = setup(); ['a', 'b', 'c', 'd'].forEach(id => t.runtime.dispatch(event(id)));
  assert.equal(t.calls.length, 2); assert.equal(t.applied(), 4);
  assert.equal(t.runtime.getSnapshot().objects[0].id, 'c');
  t.calls[0].resolve(media); await flush(); assert.equal(t.calls.length, 3);
});
test('failed request can recover; reset discards pending completions', async () => {
  const t = setup(); t.runtime.dispatch(event('a')); t.calls[0].reject(); await flush();
  assert.equal(t.runtime.getSnapshot().objects[0].mode, 'static-fallback');
  t.runtime.dispatch(event('b')); t.runtime.reset(); t.calls[1].resolve(media); await flush();
  assert.equal(t.runtime.getSnapshot().objects.length, 0); assert.equal(t.runtime.getSnapshot().history.length, 0);
});
test('only three objects survive; time decay never creates requests and memory outlives objects', async () => {
  const t = setup();
  for (let i = 0; i < 4; i++) { t.time(i * 100); t.runtime.dispatch(event(String(i))); t.calls[i].resolve(media); await flush(); t.runtime.markVisible(String(i), true); }
  assert.equal(t.runtime.getSnapshot().objects.length, 3);
  assert.equal(t.runtime.getSnapshot().objects[0].id, '1');
  t.time(50000); assert.equal(t.runtime.getSnapshot().objects.length, 0); assert.equal(t.calls.length, 4);
  assert.equal(t.runtime.getSnapshot().history.length, 4);
});
test('ledger survives reload; failed reservations do not reset the twenty-call or dollar caps', () => {
  const root = mkdtempSync(join(tmpdir(), 'vayria-slot-'));
  try {
    const ledger = new ManifestationLedger(root, 1); const id = ledger.createExperiment();
    ledger.accept(id, 'a'); assert.throws(() => ledger.accept(id, 'a'));
    for (let i = 0; i < 20; i++) ledger.reserve(id, .01);
    assert.throws(() => new ManifestationLedger(root, 1).reserve(id, .01));
    const other = ledger.createExperiment(); ledger.reserve(other, .8);
    assert.throws(() => ledger.reserve(other, .001));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('missing credentials never charge or send a request', async () => {
  let reserved = 0;
  await assert.rejects(generateManifestation({ provider: 'fal', mode: 'reused-base-video', resolution: '480p' }, () => reserved++, new AbortController().signal));
  assert.equal(reserved, 0);
});
test('green key preserves chicken colors and removes green screen', () => {
  const pixels = new Uint8ClampedArray([0,255,0,255, 255,255,255,255, 255,220,0,255, 230,20,20,255]);
  keyGreen(pixels);
  assert.equal(pixels[3], 0); assert.equal(pixels[7], 255); assert.equal(pixels[11], 255); assert.equal(pixels[15], 255);
});
test('fal sends one I2V task, polls, reserves before sending, and never sends the key to a result host', async () => {
  const reservations: number[] = []; const calls: string[] = [];
  const fake: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.ok(String(url).startsWith('https://queue.fal.run/'));
    if (init?.method === 'POST') {
      assert.equal(reservations.length, 1);
      const body = JSON.parse(String(init.body)); assert.equal(body.duration, 5); assert.equal(body.resolution, '480P'); assert.ok(body.image_url.startsWith('data:image/png;base64,'));
      return Response.json({ request_id: 'task', status_url: 'https://queue.fal.run/test/status', response_url: 'https://queue.fal.run/test/result' });
    }
    return String(url).endsWith('/status') ? Response.json({ status: 'COMPLETED' }) : Response.json({ video: { url: 'https://v3.fal.media/test.mp4' }, timings: { inference: 1.5 } });
  };
  const result = await generateManifestation({ provider: 'fal', mode: 'reused-base-video', resolution: '480p', falKey: 'test' }, usd => reservations.push(usd), new AbortController().signal, fake);
  assert.deepEqual(reservations, [.125]); assert.equal(calls.length, 3); assert.equal(result.kind, 'video'); assert.equal(result.timings.inferenceSeconds, 1.5);
});
test('Runware uses nested first frame, lowercase resolution, no conflicting dimensions', async () => {
  const fake: typeof fetch = async (_url, init) => {
    const [body] = JSON.parse(String(init?.body));
    assert.equal(body.model, 'minimax:h3@max-turbo'); assert.equal(body.resolution, '768p'); assert.equal(body.width, undefined); assert.equal(body.inputs.frameImages.length, 1);
    return Response.json({ data: [{ taskUUID: body.taskUUID, videoURL: 'https://im.runware.ai/a.mp4' }] });
  };
  const result = await generateManifestation({ provider: 'runware', mode: 'reused-base-video', resolution: '768p', runwareKey: 'test' }, () => {}, new AbortController().signal, fake);
  assert.equal(result.composite, 'green-key');
});
test('flag-disabled and public endpoints reject without contacting a provider', async () => {
  for (const config of [{ mode: 'public' as const, manifestationEnabled: true }, { mode: 'local' as const, manifestationEnabled: false }]) {
    const server = createServer((req, res) => { void handleManifestationRequest(req, res, config); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/manifestation/generate`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  }
});

test('direct fast sends one request and retains monotonic stages without invented queue timings', async () => {
  let calls = 0, reserved = 0;
  const result = await generateManifestation({ provider: 'fal', mode: 'reused-base-video', resolution: '480p', expansion: 'fast', transport: 'direct', seed: 1001, falKey: 'test' }, () => reserved++, new AbortController().signal, async (url, init) => {
    calls++; assert.equal(reserved, 1); assert.equal(String(url), 'https://fal.run/minimax/h3-max-turbo/image-to-video');
    const body = JSON.parse(String(init?.body)); assert.equal(body.prompt_expansion_mode, 'fast'); assert.equal(body.seed, 1001);
    return Response.json({ video: { url: 'https://v3.fal.media/a.mp4' } }, { headers: { 'x-fal-request-id': 'direct-id' } });
  });
  assert.equal(calls, 1); assert.deepEqual(result.trace?.requestIds, ['direct-id']);
  assert.equal(result.trace?.inferenceSeconds, undefined);
  assert.ok(result.trace?.missing.some(s => s.includes('no queue')));
  assert.ok(result.trace!.server['video.responseReceived'] >= result.trace!.server['video.submitStart']);
});

test('relay streams before EOF, supports byte ranges, and rejects unknown tickets and arbitrary hosts', async () => {
  assert.throws(() => mediaHost('https://fal.media.evil.invalid/a.mp4'));
  const ticket = createMediaTicket('https://v3.fal.media/a.mp4', 'relay-test');
  let finish: (() => void) | undefined;
  let rangeSeen = false;
  const first = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const fake: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    const range = new Headers(init?.headers).get('range');
    if (range) { rangeSeen = true; return new Response(first.slice(4, 8), { status: 206, headers: { 'content-range': 'bytes 4-7/16', 'content-length': '4' } }); }
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(first); finish = () => { finish = undefined; controller.enqueue(new Uint8Array([1])); controller.close(); }; } }));
  };
  const server = createServer((req, res) => { void relayMedia(req, res, createGenerationTrace(), fake); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address(); assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}`;
    const response = await fetch(base + ticket); // Resolves before the mock upstream closes.
    assert.equal(response.status, 200); assert.ok(finish); finish(); await response.arrayBuffer();
    const ranged = await fetch(base + ticket, { headers: { Range: 'bytes=4-7' } });
    assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 4); assert.equal(rangeSeen, true);
    assert.equal((await fetch(base + ticket, { headers: { Range: 'bytes=1-2,3-4' } })).status, 416);
    assert.equal((await fetch(base + '/api/manifestation/media/00000000-0000-0000-0000-000000000000')).status, 410);
  } finally { finish?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('additional five-dollar ceiling preserves the previous balance and per-experiment counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'manifestation-extra-budget-'));
  try {
    const before = new ManifestationLedger(root); const old = before.createExperiment(); before.reserve(old, 9.825);
    const after = new ManifestationLedger(root, 14.825);
    for (let group = 0; group < 2; group++) { const id = after.createExperiment(); for (let i = 0; i < 20; i++) after.reserve(id, .125); assert.throws(() => after.reserve(id, .125), /request-limit/); }
    assert.throws(() => after.reserve(after.createExperiment(), .125), /budget-limit/);
    assert.throws(() => before.reserve(old, .125), /budget-limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
