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
const { publicErrorMessage } = await import('../node_modules/.tmp/public-errors/errors.mjs');
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
