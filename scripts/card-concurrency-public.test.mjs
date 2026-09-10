import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const directory = 'node_modules/.tmp/card-concurrency-public';
await mkdir(directory, { recursive: true });
const client = await build({ entryPoints: ['src/public/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'public-mode', setup(b) { b.onLoad({ filter: /runtimeConfig\.ts$/ }, () => ({ contents: "export const runtimeConfig = { mode: 'public' };", loader: 'ts' })); } }] });
await writeFile(`${directory}/session.mjs`, client.outputFiles[0].text);
const { publicFetch, activatePublic } = await import('../node_modules/.tmp/card-concurrency-public/session.mjs');

test('public client consumes separate tickets for each sentence, including repeated text', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  activatePublic({ id: 'card-session', expires: Date.now() + 60000 });
  const received = [];
  globalThis.fetch = async (path, init) => {
    if (path.endsWith('/chat')) return Response.json({ text: 'ありがとう。ありがとう。', ttsTickets: [
      { text: 'ありがとう。', ttsTicket: 'first' }, { text: 'ありがとう。', ttsTicket: 'second' },
    ] });
    received.push(JSON.parse(init.body).ticket);
    return new Response(new Uint8Array([1]));
  };
  try {
    await publicFetch('/api/chat');
    await publicFetch('/api/tts', { body: JSON.stringify({ text: 'ありがとう。' }) });
    await publicFetch('/api/tts', { body: JSON.stringify({ text: 'ありがとう。' }) });
    assert.deepEqual(received, ['first', 'second']);
  } finally { Object.assign(globalThis, previous); }
});

test('continuation retries only transient busy admission and remains bounded', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  activatePublic({ id: 'retry-session', expires: Date.now() + 60000 });
  const notices = []; window.addEventListener('vayria-public-error', e => notices.push(e.detail));
  const init = { body: JSON.stringify({ cardContinuation: { deliveredText: '途中。', acknowledgementDelivered: false } }) };
  let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? Response.json({ code: 'busy', retryAt: Date.now() }, { status: 429 }) : Response.json({ text: '' });
    assert.equal((await publicFetch('/api/chat', init)).status, 200);
    assert.equal(calls, 2); assert.equal(notices.length, 0);
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ code: 'busy', retryAt: Date.now() }, { status: 429 }); };
    assert.equal((await publicFetch('/api/chat', init)).status, 429);
    assert.equal(calls, 3); assert.equal(notices.length, 1);
    calls = 0;
    const controller = new AbortController();
    globalThis.fetch = async () => { calls++; queueMicrotask(() => controller.abort()); return Response.json({ code: 'busy', retryAt: Date.now() + 1000 }, { status: 429 }); };
    await assert.rejects(publicFetch('/api/chat', { ...init, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { Object.assign(globalThis, previous); }
});

test('public worker signs the exact sentence text for JSON and streaming replies', async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023',
    plugins: [{ name: 'generation-stub', setup(b) {
      b.onLoad({ filter: /worker[\\/]usage\.ts$/ }, () => ({ contents: 'export class PublicUsage {}', loader: 'ts' }));
      b.onLoad({ filter: /worker[\\/]generation\.ts$/ }, () => ({ contents: `export async function generate(input, preview, key, signal, callbacks) {
        const response = { text: 'あ、カードありがとう。元の話を続けるね。', emotion: 'neutral', activatedCards: ['chicken'], interactionAction: 'take_floor', speechAct: 'answer', expressionLevel: 'low' };
        callbacks?.onSpeechUnit(0, response.text, response); return response;
      }`, loader: 'ts' }));
    } }] });
  await writeFile(`${directory}/worker.mjs`, bundle.outputFiles[0].text);
  const { default: worker } = await import('../node_modules/.tmp/card-concurrency-public/worker.mjs');
  const secret = 'card-test-secret-'.repeat(4);
  const payload = Buffer.from(JSON.stringify({ purpose: 'visitor', id: 'v', exp: Date.now() + 60000 })).toString('base64url');
  const cookie = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  const env = { COOKIE_SECRET: secret, GENERATION_ENABLED: 'true', OPENAI_API_KEY: 'mock', AIVIS_API_KEY: 'mock', AIVIS_MODEL_UUID: 'mock',
    USAGE: { idFromName: () => 'test', get: () => ({ fetch: async (_url, init) => {
      const operation = JSON.parse(init.body).op;
      return Response.json(operation === 'begin' ? { limits: { usdJpy: 150 }, expires: Date.now() + 60000 } : {});
    } }) } };
  const body = { mode: 'manual', message: '何を考えている？', history: [], brainCardIds: ['chicken', 'suspicious', 'sleepy', 'rain', 'gigantic'],
    forcedCardId: 'chicken', recentExpressionLevels: [], performanceContext: { callbackTendency: 0, fragmentation: 0, semanticBiases: [] },
    cardContinuation: { deliveredText: '話の前半。', acknowledgementDelivered: false } };
  for (const streamSpeech of [false, true]) {
    const request = new Request('https://test/api/chat', { method: 'POST', headers: { Origin: 'https://test', Cookie: '__Host-vayria=' + cookie, 'X-Vayria-Session': 's' }, body: JSON.stringify({ ...body, streamSpeech }) });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    const units = streamSpeech ? (await response.text()).trim().split('\n').map(JSON.parse).filter(e => e.type === 'speech_unit') : (await response.json()).ttsTickets;
    assert.deepEqual(units.map(unit => unit.text), ['あ、カードありがとう。', '元の話を続けるね。']);
    for (const unit of units) {
      const [encoded, signature] = unit.ttsTicket.split('.');
      assert.equal(signature, createHmac('sha256', secret).update(encoded).digest('base64url'));
      assert.equal(JSON.parse(Buffer.from(encoded, 'base64url')).text, unit.text);
    }
  }
});
