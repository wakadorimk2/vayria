import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const outfile = resolve('node_modules/.tmp/public-exhibition-session.mjs');
await build({ stdin: { contents: 'export * from "./src/public/session"; export * from "./src/public/exhibition";', resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'browser',
  plugins: [{ name: 'public-runtime', setup(b) {
    b.onResolve({ filter: /runtimeConfig$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const runtimeConfig = { mode: "public" };' }));
  } }] });
const api = await import(pathToFileURL(outfile));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
test('public exhibition serializes chat and STT without replacing the public session', async () => {
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  const requests = [];
  globalThis.fetch = (path, init) => new Promise(resolve => requests.push({ path, init, resolve }));
  api.activatePublic({ id: 'existing-session', expires: Date.now() + 60000 });
  api.configureExhibition('exhibition', 'duplex_auto');
  const chat = api.publicFetch('/api/chat', { method: 'POST', body: '{}' });
  const stt = api.publicFetch('/api/transcribe', { method: 'POST' });
  await settle(); assert.equal(requests.length, 1);
  requests[0].resolve(Response.json({ text: '' })); await chat; await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers.get('X-Vayria-Session'), 'existing-session');
  requests[1].resolve(Response.json({ text: 'room speech' })); await stt;
  api.configureExhibition('normal'); assert.equal(api.publicSessionId(), 'existing-session');
  assert.equal(api.isDuplexCapture(), false);
  api.pausePublic();
});
test('ending a public session prevents pending exhibition requests from being sent', async () => {
  const requests = [];
  globalThis.fetch = (path, init) => new Promise(resolve => requests.push({ path, init, resolve }));
  api.activatePublic({ id: 'first', expires: Date.now() + 60000 }); api.configureExhibition('exhibition');
  const first = api.publicFetch('/api/transcribe', { method: 'POST' });
  const pending = api.publicFetch('/api/chat', { method: 'POST', body: '{}' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await settle(); api.pausePublic(); requests[0].resolve(Response.json({ text: '' }));
  await assert.rejects(first, { name: 'AbortError' }); await rejected; assert.equal(requests.length, 1);
  api.configureExhibition('normal');
});

test('conversation settings preserve registered exhibition and cancel stale admission', async () => {
  const registration = { id: 'venue', epoch: 7, available: true, usedYen: 1234, budgetYen: 10000 };
  api.updatePublicStatus({ exhibition: registration });
  api.activatePublic({ id: 'registered', expires: Date.now() + 60000 });
  api.configureExhibition('exhibition', 'duplex_auto');
  assert.equal(api.publicExhibition(), registration);
  api.configureExhibition('normal');
  assert.equal(api.publicSessionId(), 'registered');
  assert.equal(api.publicExhibition().usedYen, 1234);
  api.pausePublic();
  let admitted;
  const unregister = api.registerPublicSessionRequest(() => new Promise(resolve => { admitted = resolve; }));
  let calls = 0;
  const pending = api.runPublicAction(() => { calls++; });
  api.cancelPublicAction();
  api.activatePublic({ id: 'registered', expires: Date.now() + 60000 });
  admitted(true);
  assert.equal(await pending, false);
  assert.equal(calls, 0);
  unregister(); api.pausePublic();
});

test('reactivating the same session cannot send queued work from its previous lifetime', async () => {
  const requests = [];
  globalThis.fetch = (path, init) => new Promise(resolve => requests.push({ path, init, resolve }));
  api.activatePublic({ id: 'same', expires: Date.now() + 60000 });
  api.configureExhibition('exhibition');
  const first = api.publicFetch('/api/transcribe', { method: 'POST' });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const pending = api.publicFetch('/api/chat', { method: 'POST', body: '{}' });
  const pendingRejected = assert.rejects(pending, { name: 'AbortError' });
  await settle();
  api.pausePublic();
  api.activatePublic({ id: 'same', expires: Date.now() + 60000 });
  requests[0].resolve(Response.json({ text: '' }));
  await firstRejected; await pendingRejected;
  assert.equal(requests.length, 1);
  api.configureExhibition('normal'); api.pausePublic();
});
