import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const outfile = resolve('node_modules/.tmp/cloud-voice-test/adapter.mjs');
await build({ stdin: { contents: 'export { createCloudVoiceAdapter } from "./src/voice/cloudVoiceAdapter"; export { getIosAudioSession } from "./src/audio/iosAudioSession"; export { configureExhibition, readAudioObservations } from "./src/public/exhibition";', resolveDir: process.cwd() }, outfile, bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'session-fixture', setup(build) {
  build.onResolve({ filter: /public\/session$/ }, () => ({ path: 'session', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const publicActive = () => globalThis.cloudVoiceFixture.active; export const publicFetch = (...args) => globalThis.cloudVoiceFixture.fetch(...args);' }));
} }] });
const { createCloudVoiceAdapter, getIosAudioSession, configureExhibition, readAudioObservations } = await import(pathToFileURL(outfile));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(ios = false) {
  configureExhibition('normal');
  const events = [], requests = [], tracks = [], nodes = [], contexts = [];
  let captureFailure = false;
  let captureWait = null;
  globalThis.window = new EventTarget();
  globalThis.document = { hidden: false };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ios ? 'iPhone' : 'Chrome Windows', audioSession: { type: 'auto' }, mediaDevices: { async getUserMedia() {
    if (captureWait) { const pending = captureWait; captureWait = null; await pending; }
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
  globalThis.cloudVoiceFixture = { active: true, fetch(path, init) { return new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })); } };
  const adapter = createCloudVoiceAdapter({ onEvent: event => events.push(event) });
  const utterance = (callback = nodes.at(-1).port.onmessage) => {
    for (let i = 0; i < 40; i++) callback?.({ data: new Int16Array(320).fill(i < 10 ? 4000 : 0).buffer });
  };
  return { adapter, events, requests, tracks, nodes, contexts, utterance, failCapture: () => { captureFailure = true; },
    deferCapture() { let resolve; captureWait = new Promise(done => { resolve = done; }); return () => resolve(); } };
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

test('iPhone releases tracks before audio and keeps them released between reply chunks', async () => {
  const f = fixture(true); await f.adapter.start();
  const session = getIosAudioSession();
  const reply = session.holdPlayback();
  assert(f.tracks[0].stopped);
  await reply.ready;
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(navigator.audioSession.type, 'playback');
  for (let i = 0; i < 3; i++) {
    const chunk = session.holdPlayback(); await chunk.ready; chunk.release(); await settle();
    assert.equal(f.tracks.length, 1);
  }
  reply.release(); await settle();
  assert.equal(f.tracks.length, 2); assert.equal(f.tracks[1].stopped, false);
  assert.equal(navigator.audioSession.type, 'play-and-record');
  assert(!f.events.some(e => e.type === 'recognition_stopped'));
  f.adapter.dispose(); await settle();
});

for (const action of ['off', 'hidden', 'expired', 'failure']) test(`iPhone auto-resume respects ${action}`, async () => {
  const f = fixture(true); await f.adapter.start();
  const held = getIosAudioSession().holdPlayback(); await held.ready;
  if (action === 'off') await f.adapter.stop();
  if (action === 'hidden') document.hidden = true;
  if (action === 'expired') globalThis.cloudVoiceFixture.active = false;
  if (action === 'failure') f.failCapture();
  held.release(); await settle();
  assert.equal(f.tracks.length, 1);
  if (action === 'failure') {
    assert.equal(f.events.at(-1).type, 'recognition_failed');
    const next = getIosAudioSession().holdPlayback(); await next.ready; next.release(); await settle();
    assert.equal(f.tracks.length, 1);
  }
  f.adapter.dispose(); await settle();
});

test('iPhone discards a late microphone acquisition after a new playback or manual stop', async () => {
  for (const action of ['playback', 'off']) {
    const f = fixture(true); await f.adapter.start();
    const session = getIosAudioSession();
    const first = session.holdPlayback(); await first.ready;
    const finishCapture = f.deferCapture(); first.release(); await settle();
    const next = action === 'playback' ? session.holdPlayback() : null;
    if (next) await next.ready; else await f.adapter.stop();
    finishCapture(); await settle();
    assert.equal(f.tracks.length, 2); assert(f.tracks.every(track => track.stopped));
    if (next) {
      next.release(); await settle();
      assert.equal(f.tracks.length, 3); assert.equal(f.tracks[2].stopped, false);
    }
    f.adapter.dispose(); await settle();
  }
});

for (const mode of ['duplex_auto', 'duplex_record']) test(`exhibition ${mode}: recording survives playback and transcriptions stay ordered`, async () => {
  const f = fixture(true); configureExhibition('exhibition', mode);
  await f.adapter.start(); f.adapter.setTtsPlaying(true);
  const hold = getIosAudioSession().holdPlayback(); await hold.ready;
  assert.equal(f.tracks[0].stopped, false);
  assert.equal(navigator.audioSession.type, mode === 'duplex_auto' ? 'auto' : 'play-and-record');
  f.utterance(); await settle(); f.utterance(); await settle();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(Response.json({ text: 'first human' })); await settle();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(Response.json({ text: 'second human' })); await settle();
  assert.deepEqual(f.events.filter(e => e.type === 'utterance_finalized').map(e => e.text), ['first human', 'second human']);
  assert(!JSON.stringify(readAudioObservations()).includes('human'));
  hold.release(); await f.adapter.stop(); f.adapter.dispose(); configureExhibition('normal');
});
test('exhibition queued transcription is discarded on stop and overflow stops capture', async () => {
  const f = fixture(); configureExhibition('exhibition', 'duplex_auto'); await f.adapter.start();
  for (let i = 0; i < 5; i++) { f.utterance(); await settle(); }
  assert(f.tracks.every(t => t.stopped));
  assert(readAudioObservations().some(e => e.event === 'queue_overflow'));
  f.requests[0].resolve(Response.json({ text: 'late' })); await settle();
  assert(!f.events.some(e => e.type === 'utterance_finalized'));
  f.adapter.dispose(); configureExhibition('normal');
});
