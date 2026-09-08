import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const outfile = resolve('node_modules/.tmp/cloud-voice-test/adapter.mjs');
await build({ entryPoints: ['src/voice/cloudVoiceAdapter.ts'], outfile, bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'session-fixture', setup(build) {
  build.onResolve({ filter: /public\/session$/ }, () => ({ path: 'session', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const publicActive = () => true; export const publicFetch = (...args) => globalThis.cloudVoiceFixture.fetch(...args);' }));
} }] });
const { createCloudVoiceAdapter } = await import(pathToFileURL(outfile));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const events = [], requests = [], tracks = [], nodes = [], contexts = [];
  let captureFailure = false;
  globalThis.window = new EventTarget();
  globalThis.document = { hidden: false };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() {
    if (captureFailure) throw new Error('denied');
    const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track);
    return { getTracks: () => [track] };
  } } } });
  globalThis.AudioContext = class {
    state = 'running'; sampleRate = 48000; destination = {}; audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {} async close() { this.state = 'closed'; }
  };
  globalThis.AudioWorkletNode = class {
    port = { onmessage: null }; disconnected = false;
    constructor() { nodes.push(this); } connect() {} disconnect() { this.disconnected = true; }
  };
  globalThis.cloudVoiceFixture = { fetch(path, init) { return new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })); } };
  const adapter = createCloudVoiceAdapter({ onEvent: event => events.push(event) });
  const utterance = (callback = nodes.at(-1).port.onmessage) => {
    for (let i = 0; i < 40; i++) callback?.({ data: new Int16Array(320).fill(i < 10 ? 4000 : 0).buffer });
  };
  return { adapter, events, requests, tracks, nodes, contexts, utterance, failCapture: () => { captureFailure = true; } };
}
for (const failure of ['http', 'network']) test(`${failure}: failure releases capture, blocks repeated audio, and allows manual restart`, async () => {
  const f = fixture(); await f.adapter.start();
  const oldCallback = f.nodes[0].port.onmessage; f.utterance();
  assert.equal(f.requests.length, 1);
  if (failure === 'http') f.requests[0].resolve(Response.json({ code: 'service_error' }, { status: 503 }));
  else f.requests[0].reject(new Error('offline'));
  await settle();
  assert.equal(f.events.at(-1).type, 'recognition_failed');
  assert(f.tracks.every(t => t.stopped)); assert(f.nodes.every(n => n.disconnected)); assert(f.contexts.every(c => c.state === 'closed'));
  f.utterance(oldCallback); assert.equal(f.requests.length, 1);
  assert(await f.adapter.start()); assert.equal(f.events.at(-1).type, 'listening_started');
  f.utterance(); assert.equal(f.requests.length, 2);
  await f.adapter.stop();
});
test('old completion cannot finalize speech or clear the new request busy flag', async () => {
  const f = fixture(); await f.adapter.start(); f.utterance();
  await f.adapter.stop(); assert(f.requests[0].init.signal.aborted);
  await f.adapter.start(); f.utterance(); assert.equal(f.requests.length, 2);
  f.requests[0].resolve(Response.json({ text: 'old' })); await settle();
  f.utterance(); assert.equal(f.requests.length, 2);
  assert(!f.events.some(e => e.type === 'utterance_finalized'));
  f.requests[1].resolve(Response.json({ text: 'new' })); await settle();
  assert.equal(f.events.at(-1).text, 'new'); await f.adapter.stop();
});
test('old failure cannot stop a restarted recording', async () => {
  const f = fixture(); await f.adapter.start(); f.utterance(); await f.adapter.stop(); await f.adapter.start();
  f.requests[0].reject(new Error('late failure')); await settle();
  assert.equal(f.events.at(-1).type, 'listening_started'); assert.equal(f.tracks[1].stopped, false);
  f.utterance(); assert.equal(f.requests.length, 2); await f.adapter.stop();
});
test('capture startup failure stays in error after cleanup', async () => {
  const f = fixture(); f.failCapture(); assert.equal(await f.adapter.start(), false);
  assert.equal(f.events.at(-1).type, 'recognition_failed'); assert.equal(f.events.at(-1).code, 'audio-capture');
  await settle(); assert.equal(f.events.at(-1).type, 'recognition_failed');
});
