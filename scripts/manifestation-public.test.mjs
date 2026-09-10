import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['worker/ledger.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { Ledger, initialState } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function setup() {
  const state = initialState(); state.limits.dayBudget = 10000000000; state.limits.monthBudget = 10000000000;
  state.limits.sessionSeconds = 3600;
  const ledger = new Ledger(state, 1000); ledger.start('v', 'ip', 's');
  return { state, ledger, event: { eventId: 'e', sessionId: 'local', generation: 0, clientId: 'c', cardId: 'chicken' } };
}
test('generation reserves once, coexists with conversation, persists and enforces visitor media ownership', () => {
  const { state, ledger, event } = setup();
  ledger.begin('v', 's', 'user', 'chat');
  ledger.manifestationBegin('v', 's', event, 'video');
  assert.throws(() => ledger.manifestationBegin('v', 's', event, 'other'), /duplicate_event/);
  assert.equal(state.manifestation.reservedMicrousd, 125000);
  ledger.manifestationComplete('v', 's', 'video', 'https://v3.fal.media/test.mp4');
  ledger.manifestationFinish('video', 'complete', { submit: 50 });
  const restored = new Ledger(JSON.parse(JSON.stringify(state)), 1100);
  assert.equal(restored.manifestationMedia('v', 'video'), 'https://v3.fal.media/test.mp4');
  assert.throws(() => restored.manifestationMedia('other', 'video'), /invalid_ticket/);
  restored.end('v', 's'); assert.throws(() => restored.manifestationMedia('v', 'video'), /session_expired/);
  assert.equal(restored.report().manifestation.reservedUsd, .125);
});
test('two simultaneous generations, failed requests retain cost and 20 per session limit', () => {
  const { ledger, state, event } = setup();
  ledger.manifestationBegin('v', 's', event, 'a');
  ledger.manifestationBegin('v', 's', { ...event, eventId: 'e2' }, 'b');
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'e3' }, 'c'), /busy/);
  ledger.manifestationFinish('a', 'provider_failure', {}); ledger.manifestationFinish('b', 'provider_failure', {});
  for (let i = 2; i < 20; i++) { ledger.manifestationBegin('v', 's', { ...event, eventId: 'event' + i }, 'j' + i); ledger.manifestationFinish('j' + i, 'provider_failure', {}); }
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'last' }, 'last'), /manifestation_limit/);
  assert.equal(state.manifestation.reservedMicrousd, 2500000);
});
test('global five dollar ceiling and existing daily budget reject before charging', () => {
  const { ledger, state, event } = setup();
  ledger.manifestationBegin('v', 's', event, 'a'); ledger.manifestationFinish('a', 'provider_failure', {});
  state.manifestation.reservedMicrousd = 5000000;
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'b' }, 'b'), /manifestation_budget/);
  state.manifestation.reservedMicrousd = 125000; state.limits.dayBudget = 1;
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'b' }, 'b'));
  assert.equal(state.manifestation.reservedMicrousd, 125000);
});
test('expired generation cannot publish', () => {
  const { ledger, state, event } = setup(); ledger.manifestationBegin('v', 's', event, 'a');
  assert.throws(() => new Ledger(state, 12000).manifestationComplete('v', 's', 'a', 'url'), /job_expired/);
});

const workerBundle = await build({ entryPoints: ['worker/manifestation.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { manifestation, mediaUrl } = await import('data:text/javascript;base64,' + Buffer.from(workerBundle.outputFiles[0].text).toString('base64'));
test('public generation is staged, fixed-input, budgeted, and relays authenticated media without credentials', async () => {
  const { ledger, event } = setup();
  const calls = []; const previous = globalThis.fetch;
  const env = { PUBLIC_HOSTNAME: 'vayria.me', PUBLIC_BASE_PATH: '/staging', REQUIRE_PREVIEW_ACCESS: 'true', GENERATION_ENABLED: 'true', MANIFESTATION_ENABLED: 'true', FAL_KEY: 'test', ASSETS: { fetch: async () => new Response('png') } };
  const call = async (op, b) => {
    calls.push(op);
    if (op === 'manifestationBegin') return ledger.manifestationBegin(b.visitor, b.id, b.manifestationEvent, b.token);
    if (op === 'manifestationComplete') return ledger.manifestationComplete(b.visitor, b.id, b.token, b.target);
    if (op === 'manifestationFinish') return ledger.manifestationFinish(b.token, b.code, b.timings);
    return ledger.manifestationMedia(b.visitor, b.token);
  };
  let submitted;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('fal.media')) {
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      assert.equal(new Headers(init.headers).get('Range'), 'bytes=0-7');
      return new Response(new Uint8Array(8), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '8', 'Content-Range': 'bytes 0-7/100' } });
    }
    if (init.method === 'POST') { assert(calls.includes('manifestationBegin')); submitted = JSON.parse(init.body); return Response.json({ request_id: 'job', status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result' }); }
    if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
    return Response.json({ video: { url: 'https://v3.fal.media/test.mp4' }, timings: { inference: .5 } });
  };
  try {
    const request = () => new Request('https://vayria.me/api/manifestation/generate', { method: 'POST', body: JSON.stringify({ event }) });
    await assert.rejects(manifestation(request(), { ...env, PUBLIC_BASE_PATH: '' }, 'v', 's', call), /not_found/);
    await assert.rejects(manifestation(request(), env, 'other', 's', call), /session_expired/);
    const response = await manifestation(request(), env, 'v', 's', call); const result = await response.json();
    assert.equal(submitted.prompt_expansion_mode, 'fast'); assert.equal(submitted.resolution, '480P');
    assert.match(result.url, /^\/staging\/api\/manifestation\/media\//);
    assert.equal(result.trace.inferenceSeconds, .5);
    const media = new Request('https://vayria.me' + result.url.replace('/staging', ''), { headers: { Range: 'bytes=0-7' } });
    await assert.rejects(manifestation(media, env, 'other', '', call), /invalid_ticket/);
    const video = await manifestation(media, env, 'v', '', call);
    assert.equal(video.status, 206); assert.equal((await video.arrayBuffer()).byteLength, 8);
    assert.throws(() => mediaUrl('https://evil.example/video.mp4'));
    assert.throws(() => mediaUrl('https://fal.media.evil.example/video.mp4'));
    assert.throws(() => mediaUrl('https://user:password@fal.media/video.mp4'));
  } finally { globalThis.fetch = previous; }
});
