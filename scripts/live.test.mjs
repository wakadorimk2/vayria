import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLiveUsageLimits } from './apply-live-usage-limits.mjs';
import { createHmac } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bundle = await build({ stdin: { contents: `export * from './worker/ledger'; export * from './worker/liveSessionManager';
export * from './worker/liveContext'; export * from './src/live/liveProtocol'; export * from './src/live/liveConversation';
export * from './src/public/inputOrbLayout';
export * from './src/audio/iosAudioSession'; export * from './src/live/liveErrors'; export {cardPool} from './src/cards/cardPool';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { inputOrbPosition, smoothInputLevel, Ledger, initialState, LiveSessionManager, openAiLiveDependencies, LiveConversation, IosAudioSession, LiveConnectionError, readLiveResponse, liveStartFailure, liveCardAppends, readLiveCards, liveCostMicroYen, cardPool } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const empty = revision => ({ swapRevision: revision, brainCardIds: [], forcedCardId: null });
const requestId = () => crypto.randomUUID();

test('input orb prefers face right, falls back left or toolbar space, and avoids occupied screens', () => {
  const anchor = { viewportWidth: 800, left: 200, right: 600, headX: 400, headY: 200, headRadius: 70 };
  assert.deepEqual(inputOrbPosition(800, 600, anchor, [], 520), { x: 506, y: 200 });
  assert.deepEqual(inputOrbPosition(520, 600, anchor, [], 520), { x: 294, y: 200 });
  const cards = [{ left: 0, top: 100, right: 800, bottom: 330 }];
  const fallback = inputOrbPosition(800, 600, anchor, cards, 520);
  assert.ok(fallback.y > 330 + 24);
  assert.ok(inputOrbPosition(390, 600, null, [], 520));
  assert.equal(inputOrbPosition(390, 600, null, [{ left: 0, top: 0, right: 390, bottom: 600 }], 520), null);
});

test('input smoothing rejects invalid levels, limits spikes, and returns to silence', () => {
  let level = smoothInputLevel(0, 1, 33);
  assert.ok(level > 0 && level < 1);
  for (let i = 0; i < 60; i++) level = smoothInputLevel(level, null, 33);
  assert.ok(level < .001);
  assert.equal(smoothInputLevel(0, NaN, 33), 0);
  assert.equal(smoothInputLevel(0, -.5, 33), 0);
});

test('sideband handshake timeout is cancelled after upgrade but still aborts a stalled handshake', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const socket = { accept() {} };
  const dependencies = openAiLiveDependencies('dummy', async (_url, options) => {
    signal = options.signal;
    return { status: 101, webSocket: socket };
  });
  assert.equal(await dependencies.attach('mock'), socket);
  t.mock.timers.tick(60_000);
  assert.equal(signal.aborted, false);
  const stalled = openAiLiveDependencies('dummy', (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('handshake timeout')), { once: true });
  }));
  const rejected = assert.rejects(stalled.attach('mock'), /handshake timeout/);
  t.mock.timers.tick(10_000);
  await rejected;
});
function accounting() {
  const state = initialState();
  const run = fn => fn(new Ledger(state, Date.now()));
  run(l => { l.configure({ sessionSeconds: 600, visitorDay: 10, visitorMonth: 310, dayBudget: 500e6 }); l.start('visitor', 'ip', 'session'); });
  return { state, run };
}
class Socket extends EventTarget {
  readyState = 1; sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
function managerFixture() {
  const { state, run } = accounting(); const sockets = []; let creates = 0;
  const dependencies = { create: async () => { creates++; return { session: { id: 'live_mock' }, transport: { sdp: 'answer' } }; },
    attach: async () => { const socket = new Socket(); sockets.push(socket); return socket; } };
  const manager = new LiveSessionManager(run, dependencies, async () => {});
  return { state, run, manager, sockets, dependencies, creates: () => creates };
}
test('reserve maximum duration, exclude duplicate starts and legacy work, settle cumulative seconds once', () => {
  const { state, run } = accounting(); const id = requestId();
  const r = run(l => l.liveBegin('visitor', 'session', id));
  assert.equal(r.reserved, liveCostMicroYen((r.expires - r.created) / 1000 + 15, 150));
  assert.equal(state.sessions.session.counts.user, 0);
  assert.equal(state.sessions.session.paid, true);
  assert.throws(() => run(l => l.liveBegin('visitor', 'session', id)), /live_active/);
  assert.throws(() => run(l => l.liveBegin('visitor', 'session', requestId())), /live_active/);
  for (const kind of ['user', 'autonomous', 'card', 'transcribe', 'tts']) assert.throws(() => run(l => l.begin('visitor', 'session', kind, 'old')), /live_active/);
  run(l => l.liveFinalize('visitor', 'session', id, 60, 'closed'));
  assert.equal(state.charges[r.charge].amount, 7_500_000); // Not 60 + 15 seconds.
  run(l => l.liveFinalize('visitor', 'session', id, 120, 'duplicate'));
  assert.equal(state.charges[r.charge].amount, 7_500_000);
  run(l => l.begin('visitor', 'session', 'user', 'legacy'));
});
test('budget denial precedes provider creation; unknown closure retains reservation', async () => {
  const f = managerFixture(); const id = requestId();
  f.run(l => l.configure({ dayBudget: 1 }));
  await assert.rejects(f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) }), /daily_budget/);
  assert.equal(f.creates(), 0);
  const { run, state } = accounting(); const r = run(l => l.liveBegin('visitor', 'session', id));
  run(l => l.liveFinalize('visitor', 'session', id, null, 'unknown'));
  assert.equal(state.charges[r.charge].settled, false);
  assert.equal(state.charges[r.charge].amount, r.reserved);
});
test('legacy concurrency includes Live sessions and ownership is enforced', () => {
  const { run } = accounting(); const id = requestId();
  run(l => { l.configure({ concurrency: 1 }); l.liveBegin('visitor', 'session', id); l.start('another', 'ip2', 'another-session'); });
  assert.throws(() => run(l => l.begin('another', 'another-session', 'user', 'job')), /busy/);
  assert.throws(() => run(l => l.liveTouch('another', 'session', id)), /session_expired/);
  assert.throws(() => run(l => l.liveClosing('another', 'session', id, 'close')), /live_session_required/);
});
test('environment limit profiles preserve all other limits and record the before state before mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vayria-live-limits-'));
  try {
    for (const environment of ['staging', 'production']) {
      let limits = { ...initialState().limits, card: 20 }; const recordPath = join(directory, environment + '.json');
      const result = await applyLiveUsageLimits({ environment, secret: 'dummy-secret'.repeat(4), recordPath,
        fetchImpl: async (url, options) => {
          assert.equal(url.pathname, environment === 'staging' ? '/staging/api/admin' : '/api/admin');
          const command = JSON.parse(options.body);
          if (command.op === 'configure') {
            const saved = JSON.parse(await readFile(recordPath, 'utf8'));
            assert.deepEqual(saved.before.limits, limits);
            assert.deepEqual(Object.keys(command).sort(), ['op', 'patch']);
            limits = { ...limits, ...command.patch };
          }
          return Response.json({ limits, stopped: false, dayYen: 12, monthApiYen: 123, activeJobs: 1 });
        } });
      assert.equal(result.limits.card, 20);
      assert.equal(result.limits.sessionSeconds, environment === 'staging' ? 600 : 300);
      const saved = JSON.parse(await readFile(recordPath, 'utf8'));
      assert.equal(saved.after.dayYen, 12); assert.equal(saved.after.activeJobs, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('registry validation and every card append fits the conservative 500 token bound', () => {
  for (const card of cardPool) {
    const cards = readLiveCards({ ...empty(Number.MAX_SAFE_INTEGER), brainCardIds: [card.id], forcedCardId: card.id });
    const chunks = liveCardAppends(cards);
    assert.ok(chunks.every(text => Buffer.byteLength(text) <= 500));
    assert.ok(chunks.join('').includes(card.id));
  }
  for (const value of [{ ...empty(0), brainCardIds: ['invented'] }, { ...empty(0), forcedCardId: 'invented' }, empty(-1), { ...empty(0), brainCardIds: [cardPool[0].id, cardPool[0].id] }]) assert.throws(() => readLiveCards(value), /invalid_live_cards/);
});
test('sideband discards stale revisions, acknowledges full snapshots, handles delegation, records no content', async () => {
  const f = managerFixture(); const id = requestId();
  await f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) });
  const socket = f.sockets[0];
  try {
    await assert.rejects(f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) }), /live_active/);
    assert.equal(f.creates(), 1);
    await f.manager.update('visitor', 'session', { requestId: id, cards: { ...empty(2), brainCardIds: [cardPool[0].id] } });
    const count = socket.sent.length;
    await f.manager.update('visitor', 'session', { requestId: id, cards: empty(1) });
    assert.equal(socket.sent.length, count);
    await f.manager.update('visitor', 'session', { requestId: id, cards: empty(3) });
    for (const event of socket.sent) socket.message({ type: 'session.thinking.appended', client_event_id: event.event_id });
    assert.equal(f.state.liveSessions.session.confirmedRevision, 3);
    socket.message({ type: 'session.delegation.created', delegation: { id: 'delegation-1', target: 'client' } });
    assert.equal(socket.sent.at(-1).delegation_id, 'delegation-1');
    assert.match(socket.sent.at(-1).content, /なし/);
    assert.ok(Buffer.byteLength(socket.sent.at(-1).content) <= 500);
    socket.message({ type: 'session.input_transcript.delta', delta: 'PRIVATE-TRANSCRIPT' });
    socket.message({ type: 'session.usage.updated', usage: { seconds: 40 } });
    socket.message({ type: 'session.usage.updated', usage: { seconds: 20 } });
    assert.equal(f.state.liveSessions.session.seconds, 40);
    assert.ok(!JSON.stringify(f.state).includes('PRIVATE-TRANSCRIPT'));
    assert.ok(!JSON.stringify(f.state).includes(cardPool[0].prompt));
  } finally { socket.message({ type: 'session.closed', usage: { seconds: 40 } }); }
  assert.equal(f.state.liveSessions.session.phase, 'closed');
});
test('server deadline, public-session end and recovered control issue close without reconnecting audio', async () => {
  for (const cause of ['lease', 'public', 'recovery']) {
    const f = managerFixture(); const id = requestId();
    await f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) });
    if (cause === 'lease') f.state.liveSessions.session.heartbeatExpires = Date.now() - 1;
    if (cause === 'public') f.run(l => l.end('visitor', 'session'));
    if (cause === 'recovery') {
      f.sockets[0].close();
      assert.equal(f.state.liveSessions.session.phase, 'unconfirmed');
      f.state.liveSessions.session.retryCloseAt = Date.now() - 1;
    }
    await f.manager.sweep();
    const socket = f.sockets.at(-1);
    assert.equal(socket.sent.at(-1).type, 'session.close');
    socket.message({ type: 'session.closed', usage: { seconds: 15 } });
    assert.equal(f.state.liveSessions.session.phase, 'closed');
    assert.equal(f.creates(), 1);
  }
});
test('concurrent start and stop during provider creation create exactly one session and close its late result', async () => {
  const f = managerFixture(); const id = requestId(); let created;
  f.dependencies.create = () => new Promise(resolve => { created = resolve; });
  const starting = f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) });
  await Promise.resolve();
  await assert.rejects(f.manager.start('visitor', 'session', { requestId: requestId(), sdp: 'offer', cards: empty(1) }), /live_active/);
  await f.manager.stop('visitor', 'session', id);
  created({ session: { id: 'live_late' }, transport: { sdp: 'answer' } });
  await assert.rejects(starting, /live_ended/);
  const socket = f.sockets.at(-1);
  assert.ok(socket.sent.some(event => event.type === 'session.close'));
  socket.message({ type: 'session.closed', usage: { seconds: 15 } });
});
test('missing session.closed expires the close window and retains reserved cost', async () => {
  const f = managerFixture(); const id = requestId();
  await f.manager.start('visitor', 'session', { requestId: id, sdp: 'offer', cards: empty(0) });
  await f.manager.stop('visitor', 'session', id);
  f.state.liveSessions.session.closingAt = Date.now() - 16000;
  await f.manager.sweep();
  assert.equal(f.state.liveSessions.session.phase, 'unconfirmed');
  assert.equal(f.state.charges['live:' + id].settled, false);
  assert.ok(f.state.liveSessions.session.retryCloseAt > Date.now());
});

function browserFixture() {
  const channel = new Socket(); channel.readyState = 'open';
  const peer = new EventTarget(); let stopped = 0; const requests = []; let frame;
  const microphone = { getTracks: () => [{ stop: () => stopped++ }] };
  Object.assign(peer, { createDataChannel: () => channel, addTrack: () => {}, createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
    iceGatheringState: 'complete', setLocalDescription: async offer => { peer.localDescription = offer; }, setRemoteDescription: async () => {}, close: () => {} });
  const node = () => ({ connect() {}, fftSize: 1024, getFloatTimeDomainData: data => data.fill(.03), gain: { value: 1 } });
  const context = { state: 'running', resume: async () => {}, close: async () => {}, createAnalyser: node, createMediaStreamSource: node, createGain: node };
  const deps = { getMicrophone: async () => microphone, peer: () => peer, audio: () => context, frame: callback => { frame = callback; return 1; }, cancelFrame: () => {},
    request: async (operation, input) => { requests.push({ operation, input }); return operation === 'start' ? { transport: { sdp: 'answer' } } : {}; } };
  const originalSend = channel.send.bind(channel);
  channel.send = text => { originalSend(text); if (JSON.parse(text).type === 'session.close') channel.message({ type: 'session.closed' }); };
  return { channel, peer, microphone, deps, requests, stopped: () => stopped, tick: () => frame() };
}

test('start errors preserve safe server codes and never display response bodies', async () => {
  await assert.rejects(readLiveResponse(Response.json({ code: 'busy', detail: 'private body' }, { status: 409 })), error => {
    assert.equal(error.code, 'busy');
    assert.match(liveStartFailure(error, 'server'), /（busy）/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  for (const response of [new Response('<html>private</html>', { status: 502 }), Response.json({ code: 'private body' }, { status: 502 })]) {
    await assert.rejects(readLiveResponse(response), error => error.code === 'live_http_502');
  }
  assert.match(liveStartFailure(new DOMException('private', 'TimeoutError'), 'server'), /（live_request_timeout）/);
  assert.match(liveStartFailure(new LiveConnectionError('live_ice_timeout'), 'ice'), /（live_ice_timeout）/);
});

test('denied microphone is identified without starting a provider session', async () => {
  const f = browserFixture();
  f.deps.getMicrophone = async () => { throw new DOMException('private browser text', 'NotAllowedError'); };
  const live = new LiveConversation(f.deps);
  assert.equal(await live.start('session', empty(0)), false);
  assert.match(live.getSnapshot().error, /（microphone_permission_denied）/);
  assert.doesNotMatch(live.getSnapshot().error, /private/);
  assert.equal(f.requests.filter(r => r.operation === 'start').length, 0);
});

test('WebKit-shaped exceptions retain their names without Error inheritance', () => {
  for (const [name, code] of [['NotAllowedError', 'microphone_permission_denied'], ['NotReadableError', 'microphone_unavailable'], ['AbortError', 'microphone_aborted'], ['InvalidStateError', 'microphone_state_failed']]) {
    assert.match(liveStartFailure({ name, message: 'private' }, 'microphone'), new RegExp(`（${code}）`));
    assert.doesNotMatch(liveStartFailure({ name, message: 'private' }, 'microphone'), /private/);
  }
});

test('Live enters iOS recording mode before acquisition and restores playback on stop or failure', async () => {
  for (const denied of [false, true]) {
    const f = browserFixture(); let type = 'playback';
    const session = new IosAudioSession(value => { type = value; });
    const unregisterLegacy = session.register({ pause: async () => {}, resume: async () => false });
    f.deps.holdRecording = () => session.holdRecording();
    f.deps.getMicrophone = async () => {
      assert.equal(type, 'play-and-record');
      unregisterLegacy(); // Late legacy cleanup cannot revert an active Live session.
      assert.equal(type, 'play-and-record');
      if (denied) throw { name: 'NotAllowedError' };
      return f.microphone;
    };
    const live = new LiveConversation(f.deps);
    assert.equal(await live.start('session', empty(0)), !denied);
    if (!denied) {
      const playback = session.holdPlayback(); await playback.ready;
      assert.equal(type, 'play-and-record'); playback.release();
      await live.stop(); assert.ok(f.stopped() > 0);
    }
    assert.equal(type, 'playback');
  }
});

test('server rejection releases microphone and retains its diagnostic code', async () => {
  const f = browserFixture();
  f.deps.request = async operation => { if (operation === 'start') throw new LiveConnectionError('busy'); return {}; };
  const live = new LiveConversation(f.deps);
  assert.equal(await live.start('session', empty(0)), false);
  assert.match(live.getSnapshot().error, /（busy）/);
  assert.ok(f.stopped() > 0);
});
test('browser sends latest preparation-time placement and separates overlapping captions from playback', async () => {
  const f = browserFixture(); let resolveMic;
  f.deps.getMicrophone = () => new Promise(resolve => { resolveMic = resolve; });
  const live = new LiveConversation(f.deps); const pending = live.start('public-session', empty(0));
  live.updateCards(empty(2)); resolveMic(f.microphone); assert.equal(await pending, true);
  assert.equal(f.requests[0].input.cards.swapRevision, 2);
  const track = new Event('track'); Object.assign(track, { streams: [{}] }); f.peer.dispatchEvent(track);
  f.tick(); assert.equal(live.getSnapshot().speaking, true); assert.ok(live.getSnapshot().mouthOpen > 0);
  f.channel.message({ type: 'session.started' });
  await Promise.resolve();
  const before = live.getSnapshot().speaking;
  f.channel.message({ type: 'session.input_transcript.delta', event_id: 'u', delta: 'あ、', start_ms: 10, end_ms: 50 });
  f.channel.message({ type: 'session.output_transcript.delta', event_id: 'a', delta: 'うん', start_ms: 20, end_ms: 70 });
  assert.equal(live.getSnapshot().captions.length, 2);
  assert.equal(live.getSnapshot().speaking, before);
  live.setVolume(0); f.tick(); assert.equal(live.getSnapshot().mouthOpen, 0);
  live.updateCards(empty(4)); live.updateCards(empty(3));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.requests.filter(r => r.operation === 'context').at(-1).input.cards.swapRevision, 4);
  await live.stop(); assert.ok(f.stopped() > 0); assert.equal(live.getSnapshot().phase, 'idle');
  f.channel.message({ type: 'session.output_transcript.delta', delta: 'stale', start_ms: 90, end_ms: 100 });
  assert.equal(live.getSnapshot().captions.length, 2);
});
test('stop while microphone permission is pending disposes the late microphone and never starts upstream', async () => {
  const f = browserFixture(); let resolveMic;
  f.deps.getMicrophone = () => new Promise(resolve => { resolveMic = resolve; });
  const live = new LiveConversation(f.deps); const starting = live.start('session', empty(0));
  await live.stop(); resolveMic(f.microphone); assert.equal(await starting, false);
  assert.equal(f.requests.filter(r => r.operation === 'start').length, 0); assert.ok(f.stopped() > 0);
});
test('late audio unlock completion does not request playback after stopping', async () => {
  const f = browserFixture(); const context = f.deps.audio(); let rejectResume;
  context.resume = () => new Promise((_, reject) => { rejectResume = reject; });
  const live = new LiveConversation(f.deps); live.prepare(); await live.stop();
  rejectResume(new Error('old context closed')); await Promise.resolve(); await Promise.resolve();
  assert.equal(live.getSnapshot().needsPlaybackGesture, false);
});
test('App gates legacy callbacks, resets conversation without resetting cards, and closes hidden pages', async () => {
  const app = await readFile('src/App.tsx', 'utf8');
  for (const marker of ['(event: VoiceInputEvent) => {', '(decision: ConversationActionDecision) => {', 'const playCue = () => {']) assert.ok(app.slice(app.indexOf(marker), app.indexOf(marker) + 150).includes('liveSelectedRef.current'));
  const switching = app.slice(app.indexOf('const selectVoiceEngine'), app.indexOf('const handleVoiceToggle'));
  for (const call of ['cancelAutonomous', 'interruptCurrentTurn', 'playbackCoordinator.stop', 'stopVoiceInput', 'liveController.stop', 'resetConversation']) assert.ok(switching.includes(call));
  assert.ok(!switching.includes('resetCards'));
  const hook = await readFile('src/live/useLiveConversation.ts', 'utf8');
  assert.match(hook, /visibilitychange/); assert.match(hook, /pagehide/); assert.match(hook, /!publicActive\(\)/);
});

test('Worker rejects production, missing preview, wrong Origin, missing visitor and missing public session', async () => {
  const worker = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:workers'] });
  const secret = 'dummy-secret-for-live-tests-'.repeat(3);
  const sign = payload => { const p = Buffer.from(JSON.stringify(payload)).toString('base64url'); return p + '.' + createHmac('sha256', secret).update(p).digest('base64url'); };
  for (const staging of [false, true]) {
    let upstream = 0;
    const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'live', modules: true, script: worker.outputFiles[0].text,
      compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'], durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
      bindings: { COOKIE_SECRET: secret, PREVIEW_SECRET: secret, IP_SECRET: secret, OPENAI_API_KEY: 'dummy', GENERATION_ENABLED: 'true',
        PUBLIC_BASE_PATH: staging ? '/staging' : '', REQUIRE_PREVIEW_ACCESS: staging ? 'true' : 'false' },
      serviceBindings: { ASSETS: () => new Response('asset') }, outboundService: () => { upstream++; return new Response('', { status: 500 }); },
    }] }));
    try {
      const base = 'https://test.example'; const path = (staging ? '/staging' : '') + '/api/live/start';
      const call = (cookie = '', origin = base) => mf.dispatchFetch(base + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: requestId(), sdp: 'offer', cards: empty(0) }) });
      assert.equal((await call()).status, staging ? 403 : 404);
      if (staging) {
        const admitted = await mf.dispatchFetch(base + '/staging/preview', { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: sign({ purpose: 'preview', exp: Date.now() + 60000 }) }).toString() });
        const preview = admitted.headers.get('set-cookie').split(';')[0];
        assert.equal((await call(preview, 'https://wrong.example')).status, 403);
        assert.equal((await call(preview)).status, 403);
        const status = await mf.dispatchFetch(base + '/staging/api/session', { headers: { Cookie: preview } });
        const visitor = status.headers.get('set-cookie').split(';')[0];
        assert.equal((await call(preview + '; ' + visitor)).status, 401);
      }
      assert.equal(upstream, 0);
    } finally { await mf.dispose(); }
  }
});
