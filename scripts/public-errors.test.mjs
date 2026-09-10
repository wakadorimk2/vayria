import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('node_modules/.tmp/public-errors', { recursive: true });
const result = await build({ entryPoints: ['src/public/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'public-runtime', setup(b) { b.onLoad({ filter: /runtimeConfig\.ts$/ }, () => ({ contents: "export const runtimeConfig = { mode: 'public' };", loader: 'ts' })); } }] });
await writeFile('node_modules/.tmp/public-errors/session.mjs', result.outputFiles[0].text);
const format = await build({ entryPoints: ['src/public/errors.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
await writeFile('node_modules/.tmp/public-errors/errors.mjs', format.outputFiles[0].text);
const { publicErrorMessage, voiceInputNoticeMessage } = await import('../node_modules/.tmp/public-errors/errors.mjs');
const { activatePublic, publicFetch } = await import('../node_modules/.tmp/public-errors/session.mjs');
test('HTTP and streaming errors show the same reason and valid retry time', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  const notices = []; window.addEventListener('vayria-public-error', e => notices.push(e.detail));
  activatePublic({ id: 's', expires: Date.now() + 60000 });
  try {
    for (const code of ['card_limit', 'user_limit', 'tts_limit', 'daily_budget', 'monthly_budget', 'session_expired', 'busy', 'generation_failed', 'unknown']) {
      const reason = { code, retryAt: Date.now() + 5000 };
      globalThis.fetch = async () => Response.json(reason, { status: 429 });
      const http = await publicFetch('/api/chat');
      assert.equal(http.status, 429); assert.equal((await http.json()).error, publicErrorMessage(reason));
      const line = JSON.stringify({ type: 'error', ...reason, error: 'old message' });
      globalThis.fetch = async () => new Response(line + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      const stream = JSON.parse(await (await publicFetch('/api/chat')).text());
      assert.equal(stream.error, publicErrorMessage(reason));
      assert.equal(publicErrorMessage(notices.at(-1)), stream.error);
    }
    globalThis.fetch = async () => { throw new TypeError('network'); };
    assert.equal((await (await publicFetch('/api/chat')).json()).error, publicErrorMessage({ code: 'network_error' }));
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('stream disconnected')); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    const disconnected = JSON.parse(await (await publicFetch('/api/chat')).text());
    assert.equal(disconnected.error, publicErrorMessage({ code: 'network_error' }));
    assert.equal(publicErrorMessage(notices.at(-1)), disconnected.error);
    globalThis.fetch = async () => { throw new TypeError('network'); };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => publicFetch('/api/chat', { signal: controller.signal }));
  } finally { Object.assign(globalThis, previous); }
});
test('invalid retry times and unrecognized payloads never leak content or throw', () => {
  for (const retryAt of [0, -1, Infinity, NaN, 'tomorrow', 1e30]) assert.equal(publicErrorMessage({ code: 'card_limit', retryAt }).includes('再開可能'), false);
  for (const reason of [null, 'private text', { code: '__proto__', error: 'private text' }]) assert.equal(publicErrorMessage(reason).includes('private'), false);
});

test('transcription failures carry their source and do not end the public session', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  const notices = []; const stops = [];
  window.addEventListener('vayria-public-error', event => notices.push(event.detail));
  window.addEventListener('vayria-public-stop', event => stops.push(event));
  activatePublic({ id: 's', expires: Date.now() + 60000 });
  try {
    globalThis.fetch = async () => Response.json({ code: 'provider_unavailable' }, { status: 502 });
    await publicFetch('/api/transcribe');
    assert.equal(notices[0].source, '/api/transcribe'); assert.equal(stops.length, 0);
    await publicFetch('/api/chat'); assert.equal(notices[1].source, '/api/chat');
  } finally { Object.assign(globalThis, previous); }
});

test('voice notices distinguish recovery, microphone permission and usage limits', () => {
  assert.equal(voiceInputNoticeMessage({ state: 'recovering', code: 'network_error', at: 1 }), '音声入力を再開しています');
  assert.equal(voiceInputNoticeMessage({ state: 'resumed', code: '', at: 2 }), 'もう一度どうぞ');
  assert.match(voiceInputNoticeMessage({ state: 'failed', code: 'not-allowed', at: 1 }), /マイクの許可/);
  const notice = { state: 'failed', code: 'transcribe_limit', at: 1, retryAt: Date.now() + 5000 };
  assert.match(voiceInputNoticeMessage(notice), /再開:.*日本時間/);
  assert.match(voiceInputNoticeMessage(notice), /文字やカード/);
  assert(!voiceInputNoticeMessage({ state: 'failed', code: '<private>', at: 1 }).includes('private'));
});

test('staging transcription failures retain the canonical voice-only notification source', async () => {
  const built = await build({ entryPoints: ['src/public/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env.BASE_URL': '"/staging/"' },
    plugins: [{ name: 'public-runtime', setup(b) { b.onLoad({ filter: /runtimeConfig\.ts$/ }, () => ({ contents: "export const runtimeConfig = { mode: 'public' };", loader: 'ts' })); } }] });
  const mounted = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  const notices = []; window.addEventListener('vayria-public-error', event => notices.push(event.detail));
  try {
    mounted.activatePublic({ id: 's', expires: Date.now() + 60000 });
    globalThis.fetch = async path => { assert.equal(path, '/staging/api/transcribe'); return Response.json({ code: 'network_error' }, { status: 503 }); };
    await mounted.publicFetch('/api/transcribe');
    assert.equal(notices[0].source, '/api/transcribe'); assert.equal(mounted.publicActive(), true);
  } finally { Object.assign(globalThis, previous); }
});
