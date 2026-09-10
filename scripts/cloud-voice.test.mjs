import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const outfile = resolve('node_modules/.tmp/cloud-voice-test/adapter.mjs');
await build({ stdin: { contents: 'export { createCloudVoiceAdapter } from "./src/voice/cloudVoiceAdapter"; export { getIosAudioSession } from "./src/audio/iosAudioSession";', resolveDir: process.cwd() }, outfile, bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'session-fixture', setup(build) {
  build.onResolve({ filter: /public\/session$/ }, () => ({ path: 'session', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const publicActive = () => globalThis.cloudVoiceFixture.active; export const publicFetch = (...args) => globalThis.cloudVoiceFixture.fetch(...args);' }));
} }] });
const { createCloudVoiceAdapter, getIosAudioSession } = await import(pathToFileURL(outfile));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(ios = false, initialPacket = true) {
  const events = [], requests = [], tracks = [], nodes = [], contexts = [];
  let captureFailure = false;
  let captureWait = null;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ios ? 'iPhone' : 'Chrome Windows', audioSession: { type: 'auto' }, mediaDevices: { async getUserMedia() {
    if (captureWait) { const pending = captureWait; captureWait = null; await pending; }
    if (captureFailure) throw captureFailure;
    const track = { stopped: false, readyState: 'live', muted: false, stop() { this.stopped = true; this.readyState = 'ended'; } }; tracks.push(track);
    return { getTracks: () => [track] };
  } } } });
  globalThis.AudioContext = class {
    state = 'running'; sampleRate = 48000; destination = {}; audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {} async close() { this.state = 'closed'; }
  };
  globalThis.AudioWorkletNode = class {
    port = { callback: null, get onmessage() { return this.callback; }, set onmessage(value) {
      this.callback = value;
      if (value && initialPacket) queueMicrotask(() => value({ data: new Int16Array(320).buffer }));
    } }; disconnected = false;
    constructor() { nodes.push(this); } connect() {} disconnect() { this.disconnected = true; }
  };
  globalThis.cloudVoiceFixture = { active: true, fetch(path, init) { return new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })); } };
  const adapter = createCloudVoiceAdapter({ onEvent: event => events.push(event) });
  const utterance = (callback = nodes.at(-1).port.onmessage) => {
    for (let i = 0; i < 40; i++) callback?.({ data: new Int16Array(320).fill(i < 10 ? 4000 : 0).buffer });
  };
  return { adapter, events, requests, tracks, nodes, contexts, utterance, failCapture: (error = new Error('capture failed')) => { captureFailure = error; },
    deferCapture() { let resolve; captureWait = new Promise(done => { resolve = done; }); return () => resolve(); } };
}

test('listening requires the first PCM packet, including silent input', async () => {
  const f = fixture(true, false);
  await f.adapter.start();
  assert.equal(f.events.at(-1).type, 'listening_pending');
  assert(!f.events.some(e => e.type === 'listening_started'));
  f.nodes[0].port.onmessage({ data: new Int16Array(320).buffer });
  assert.equal(f.events.at(-1).type, 'listening_started');
  assert.equal(f.requests.length, 0);
  f.adapter.dispose(); await settle();
});

for (const cause of ['interrupted', 'ended', 'muted', 'processor', 'packets']) test(`capture ${cause}: reacquires and accepts the next utterance`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); await f.adapter.start();
  const oldPacket = f.nodes[0].port.onmessage;
  if (cause === 'interrupted') { f.contexts[0].state = 'interrupted'; f.contexts[0].onstatechange(); }
  if (cause === 'ended') { f.tracks[0].readyState = 'ended'; f.tracks[0].onended(); }
  if (cause === 'muted') { f.tracks[0].muted = true; f.tracks[0].onmute(); }
  if (cause === 'processor') f.nodes[0].onprocessorerror();
  if (cause === 'packets') t.mock.timers.tick(5000);
  assert.equal(f.events.at(-1).type, 'listening_pending');
  assert(f.tracks[0].stopped);
  f.utterance(oldPacket); assert.equal(f.requests.length, 0);
  t.mock.timers.tick(1000); await settle();
  assert.equal(f.tracks.length, 2); assert.equal(f.events.at(-1).type, 'listening_started');
  f.utterance(); assert.equal(f.requests.length, 1);
  f.adapter.dispose(); await settle();
});

test('no packets exhaust three capture retries without sending audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true, false); await f.adapter.start();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5000); await settle();
    t.mock.timers.tick(1000); await settle();
  }
  t.mock.timers.tick(5000); await settle();
  assert.equal(f.tracks.length, 4);
  assert.equal(f.events.at(-1).type, 'recognition_failed');
  assert.equal(f.events.at(-1).recoverable, false);
  assert(!f.events.some(e => e.type === 'listening_started'));
  t.mock.timers.tick(60000); await settle();
  assert.equal(f.tracks.length, 4); assert.equal(f.requests.length, 0);
  f.adapter.dispose(); await settle();
});

test('silent PCM keeps capture healthy without recognizing silence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); await f.adapter.start();
  for (let i = 0; i < 60; i++) {
    f.nodes[0].port.onmessage({ data: new Int16Array(320).buffer });
    t.mock.timers.tick(1000); await settle();
  }
  assert.equal(f.tracks.length, 1); assert.equal(f.requests.length, 0);
  assert.equal(f.events.at(-1).type, 'listening_started');
  f.adapter.dispose(); await settle();
});

test('playback cancels capture retry and resumes only after releasing ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); await f.adapter.start(); f.nodes[0].onprocessorerror();
  const held = getIosAudioSession().holdPlayback(); await held.ready;
  t.mock.timers.tick(2000); await settle(); assert.equal(f.tracks.length, 1);
  held.release(); await settle(); assert.equal(f.tracks.length, 2);
  f.utterance(); assert.equal(f.requests.length, 1);
  f.adapter.dispose(); await settle();
});

for (const action of ['off', 'hidden', 'expired', 'dispose']) test(`capture retry is cancelled by ${action}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); await f.adapter.start(); f.nodes[0].onprocessorerror();
  if (action === 'off') await f.adapter.stop();
  if (action === 'hidden') { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); }
  if (action === 'expired') { cloudVoiceFixture.active = false; window.dispatchEvent(new Event('vayria-public-stop')); }
  if (action === 'dispose') f.adapter.dispose();
  await settle(); t.mock.timers.tick(60000); await settle();
  assert.equal(f.tracks.length, 1); assert(f.tracks.every(t => t.stopped));
  f.adapter.dispose(); await settle();
});

test('stuck iOS playback never advertises listening or reacquires over playback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); const held = getIosAudioSession().holdPlayback(); await held.ready;
  await f.adapter.start();
  assert.equal(f.events.at(-1).reason, 'playback-wait');
  t.mock.timers.tick(60000); await settle();
  assert.equal(f.events.at(-1).code, 'playback-timeout');
  assert.equal(f.events.at(-1).recoverable, false);
  assert.equal(f.tracks.length, 0);
  held.release(); await settle(); assert.equal(f.tracks.length, 0);
  await f.adapter.start(); assert.equal(f.events.at(-1).type, 'listening_started');
  f.adapter.dispose(); await settle();
});

test('hanging AudioContext.close does not block iOS playback or capture restart', async () => {
  const f = fixture(true); await f.adapter.start();
  f.contexts[0].close = () => new Promise(() => {});
  const held = getIosAudioSession().holdPlayback();
  await held.ready; assert(f.tracks[0].stopped);
  held.release(); await settle(); assert.equal(f.tracks.length, 2);
  f.utterance(); assert.equal(f.requests.length, 1);
  f.adapter.dispose(); await settle();
});

for (const action of ['timeout', 'off']) test(`pending microphone permission settles on ${action} and stops late tracks`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(true); const finish = f.deferCapture(); const started = f.adapter.start();
  if (action === 'timeout') t.mock.timers.tick(15000);
  else await f.adapter.stop();
  await settle(); assert.equal(await started, false);
  if (action === 'timeout') assert.equal(f.events.at(-1).code, 'audio-capture');
  finish(); await settle(); assert(f.tracks.every(t => t.stopped));
  assert(!f.events.some(e => e.type === 'listening_started'));
  f.adapter.dispose(); await settle();
});
for (const failure of ['http', 'network']) test(`${failure}: failure preserves capture and resumes without a click or retransmission`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); await f.adapter.start();
  const oldCallback = f.nodes[0].port.onmessage; f.utterance();
  assert.equal(f.requests.length, 1);
  if (failure === 'http') f.requests[0].resolve(Response.json({ code: 'provider_unavailable' }, { status: 502 }));
  else f.requests[0].reject(new Error('offline'));
  await settle();
  assert.equal(f.events.at(-1).type, 'recognition_failed');
  assert.equal(f.events.at(-1).recoverable, true);
  assert(f.tracks.every(t => !t.stopped)); assert(f.nodes.every(n => !n.disconnected));
  f.utterance(oldCallback); assert.equal(f.requests.length, 1);
  t.mock.timers.tick(999); assert.equal(f.events.at(-1).type, 'recognition_failed');
  t.mock.timers.tick(1); assert.equal(f.events.at(-1).type, 'listening_started');
  assert.equal(f.events.at(-1).recovered, true); assert.equal(f.requests.length, 1);
  f.utterance(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(Response.json({ text: '話し直しました' })); await settle();
  assert.equal(f.events.at(-1).text, '話し直しました'); assert.equal(f.tracks.length, 1);
  await f.adapter.stop();
});

test('consecutive failures back off, respect retryAt and reset after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); await f.adapter.start();
  for (const delay of [1000, 3000, 10000, 30000, 30000]) {
    f.utterance(); f.requests.at(-1).resolve(Response.json({ code: 'busy' }, { status: 429 })); await settle();
    assert.equal(f.events.at(-1).retryAt, Date.now() + delay);
    const count = f.requests.length;
    f.utterance(); t.mock.timers.tick(delay); assert.equal(f.requests.length, count);
  }
  f.utterance(); f.requests.at(-1).resolve(Response.json({ text: '成功' })); await settle();
  f.utterance(); f.requests.at(-1).resolve(Response.json({ code: 'busy', retryAt: Date.now() + 5000 }, { status: 429 })); await settle();
  assert.equal(f.events.at(-1).retryAt, Date.now() + 5000);
  t.mock.timers.tick(4999); f.utterance(); const count = f.requests.length;
  t.mock.timers.tick(1); f.utterance(); assert.equal(f.requests.length, count + 1);
  f.requests.at(-1).resolve(Response.json({ text: '成功' })); await settle();
  f.utterance(); f.requests.at(-1).resolve(Response.json({ text: '' })); await settle();
  assert.equal(f.events.at(-1).retryAt, Date.now() + 1000);
  await f.adapter.stop();
});

for (const code of ['transcribe_limit', 'audio_limit', 'user_limit', 'daily_budget', 'session_expired', 'generation_stopped', 'unexpected']) {
  test(`${code}: stops only capture and retains the reason without automatic restart`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const f = fixture(); await f.adapter.start(); f.utterance();
    const retryAt = Date.now() + 5000;
    f.requests[0].resolve(Response.json({ code, retryAt }, { status: 429 })); await settle();
    assert.equal(f.events.at(-1).code, code); assert.equal(f.events.at(-1).retryAt, retryAt);
    assert.equal(f.events.at(-1).recoverable, false); assert(f.tracks.every(track => track.stopped));
    t.mock.timers.tick(60000); assert.equal(f.requests.length, 1); assert.equal(f.tracks.length, 1);
    assert.equal(globalThis.cloudVoiceFixture.active, true); f.adapter.dispose(); await settle();
  });
}

for (const action of ['off', 'hidden', 'expired', 'dispose']) test(`recovery is cancelled by ${action}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); await f.adapter.start(); f.utterance();
  f.requests[0].reject(new TypeError('offline')); await settle();
  if (action === 'off') await f.adapter.stop();
  if (action === 'hidden') { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); }
  if (action === 'expired') { globalThis.cloudVoiceFixture.active = false; window.dispatchEvent(new Event('vayria-public-stop')); }
  if (action === 'dispose') f.adapter.dispose();
  await settle(); const count = f.events.length;
  t.mock.timers.tick(60000); await settle();
  assert.equal(f.events.length, count); assert(f.tracks.every(track => track.stopped));
  f.adapter.dispose(); await settle();
});

test('iPhone recovery waits for the entire playback before reacquiring capture', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(true); await f.adapter.start(); f.utterance();
  f.requests[0].reject(new TypeError('offline')); await settle();
  const held = getIosAudioSession().holdPlayback(); await held.ready;
  t.mock.timers.tick(1000); await settle();
  assert.equal(f.events.at(-1).type, 'recognition_failed'); assert.equal(f.tracks.length, 1);
  held.release(); await settle();
  assert.equal(f.events.at(-1).type, 'listening_started'); assert.equal(f.events.at(-1).recovered, true);
  assert.equal(f.tracks.length, 2); f.utterance(); assert.equal(f.requests.length, 2);
  f.adapter.dispose(); await settle();
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

test('an old recovery timer and capture callback cannot alter a newly started request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); await f.adapter.start(); const oldCapture = f.nodes[0].port.onmessage;
  f.utterance(); f.requests[0].reject(new TypeError('offline')); await settle();
  await f.adapter.stop(); await f.adapter.start(); f.utterance();
  const count = f.events.length;
  t.mock.timers.tick(30000); f.utterance(oldCapture);
  assert.equal(f.events.length, count); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(Response.json({ text: '新しい発話' })); await settle();
  assert.equal(f.events.at(-1).text, '新しい発話'); await f.adapter.stop();
});

test('permission denial requires an explicit action and does not loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.failCapture(new DOMException('denied', 'NotAllowedError'));
  assert.equal(await f.adapter.start(), false);
  assert.equal(f.events.at(-1).code, 'not-allowed'); assert.equal(f.events.at(-1).recoverable, false);
  const count = f.events.length; t.mock.timers.tick(60000);
  assert.equal(f.events.length, count); assert.equal(f.requests.length, 0); f.adapter.dispose(); await settle();
});

test('playback completion at the recovery deadline cannot emit a second listening start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); await f.adapter.start(); f.utterance();
  f.requests[0].reject(new TypeError('offline')); await settle();
  f.adapter.setTtsPlaying(true);
  t.mock.timers.setTime(Date.now() + 1000);
  f.adapter.setTtsPlaying(false);
  f.utterance(); const count = f.events.length;
  t.mock.timers.tick(1);
  assert.equal(f.events.length, count); assert.equal(f.requests.length, 2);
  await f.adapter.stop();
});

for (const result of [{ text: 42 }, null]) test(`invalid STT response ${JSON.stringify(result)} does not reach conversation`, async () => {
  const f = fixture(); await f.adapter.start(); f.utterance();
  f.requests[0].resolve(Response.json(result)); await settle();
  assert.equal(f.events.at(-1).code, 'recognition-failed'); assert.equal(f.events.at(-1).recoverable, false);
  assert(!f.events.some(event => event.type === 'utterance_finalized')); f.adapter.dispose(); await settle();
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
