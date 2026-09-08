import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { adminCommand } from './public-admin-command.mjs';
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { Ledger, initialState, DEFAULT_LIMITS } = await load('worker/ledger.ts');
const { prepareHandoff, readHandoff, completeHandoff, allowExhibitionAutonomy } = await load('src/public/exhibitionHandoff.ts');
const now = Date.parse('2026-09-23T12:00:00+09:00');
const hash = 'a'.repeat(64);
const eventId = 'expo-20260923';
function setup() {
  const l = new Ledger(initialState(), now);
  const config = adminCommand('exhibition-create');
  l.createExhibition(config.event, config.starts, config.expires, config.budget);
  l.issueExhibitionCode(eventId, hash); l.enrollExhibition('ipad', hash);
  return l;
}
function start(l, visitor = 'ipad', id = crypto.randomUUID()) {
  return l.start(visitor, 'venue-ip', id, l.status(visitor).exhibition.epoch).session.id;
}
function spend(l, visitor, session, amount, actual) {
  const job = crypto.randomUUID(), charge = crypto.randomUUID();
  l.begin(visitor, session, 'card', job); l.reserve(visitor, session, job, charge, amount);
  if (actual !== undefined) l.settle(charge, actual);
  l.finish(job); return charge;
}
test('CLI uses the approved date, total 10000 yen, and rejects incomplete rehearsal configuration', () => {
  const c = adminCommand('exhibition-create');
  assert.equal(c.budget, 10_000_000_000); assert.equal(c.expires - c.starts, 86400_000);
  assert.equal(c.starts, Date.parse('2026-09-23T00:00:00+09:00'));
  assert.throws(() => adminCommand('exhibition-create', '{}'));
  assert.deepEqual(adminCommand('exhibition-stop', eventId), { op: 'exhibition-stop', event: eventId });
});
test('codes expire after 15 minutes, are consumed once, and only grant the enrolled visitor', () => {
  const l = setup();
  assert.throws(() => l.enrollExhibition('other', hash), /exhibition_code_invalid/);
  assert.equal(l.status('other').exhibition, null);
  assert.throws(() => l.enrollExhibition('other', 'f'.repeat(64)), /exhibition_code_invalid/);
  l.issueExhibitionCode(eventId, hash);
  const later = new Ledger(l.state, now + 900_000);
  assert.throws(() => later.enrollExhibition('other', hash), /exhibition_code_invalid/);
});
test('5.5 hours and 330 participant handoffs do not hit public quotas; public counters stay unchanged', () => {
  let l = setup();
  for (let minute = 0; minute < 330; minute++) {
    l = new Ledger(l.state, now + minute * 60000);
    const session = start(l);
    spend(l, 'ipad', session, 1_000_000);
    l.nextExhibitionVisitor('ipad', crypto.randomUUID(), l.status('ipad').exhibition.epoch);
  }
  assert.equal(l.status('ipad').exhibition.usedYen, 330);
  assert.equal(l.report().dayYen, 0); assert.equal(l.report().monthApiYen, 0);
  assert.deepEqual(l.state.limits, DEFAULT_LIMITS);
  const publicSession = l.start('public', 'venue-ip', 'public').session.id;
  for (let i = 0; i < DEFAULT_LIMITS.card; i++) spend(l, 'public', publicSession, 1);
  assert.throws(() => spend(l, 'public', publicSession, 1), /card_limit/);
});
test('same event budget is shared across devices, re-enrollment, reload and handoff', () => {
  let l = setup(); const s = start(l); spend(l, 'ipad', s, 5_000_000_000);
  assert.equal(l.status('ipad').exhibition.warning, '50');
  l.issueExhibitionCode(eventId, hash); l.enrollExhibition('backup', hash);
  spend(l, 'backup', start(l, 'backup'), 3_000_000_000);
  l = new Ledger(JSON.parse(JSON.stringify(l.state)), now + 1000);
  assert.equal(l.status('ipad').exhibition.warning, '80');
  l.issueExhibitionCode(eventId, hash); l.enrollExhibition('ipad', hash);
  const current = start(l); spend(l, 'ipad', current, 2_000_000_000);
  assert.equal(l.status('ipad').exhibition.usedYen, 10000);
  assert.throws(() => spend(l, 'ipad', current, 1), /exhibition_budget/);
  assert.throws(() => l.createExhibition(eventId, now, now + 10000, 1), /invalid_config/);
});
test('reservations reject overshoot, settlement is idempotent, unknown failures retain reservations', () => {
  const l = setup(); const s = start(l);
  const charge = spend(l, 'ipad', s, 5_000_000_000, 4_000_000_000);
  l.settle(charge, 0); assert.equal(l.status('ipad').exhibition.usedYen, 4000);
  spend(l, 'ipad', s, 5_000_000_000);
  assert.throws(() => spend(l, 'ipad', s, 1_000_000_001), /exhibition_budget/);
  assert.equal(l.status('ipad').exhibition.usedYen, 9000);
});
test('provider overrun stops only the event; global emergency stop still blocks exhibits', () => {
  const l = setup(); const s = start(l);
  spend(l, 'ipad', s, 100, 200);
  assert.equal(l.state.stopped, false); assert.equal(l.status('ipad').exhibition.stopped, true);
  assert.throws(() => l.begin('ipad', s, 'user', 'job'), /exhibition_unavailable/);
  const other = setup(); other.configure({}, true);
  assert.throws(() => start(other), /generation_stopped/);
});
test('generation epochs reject late starts and old TTS; duplicate handoff does not end the next session', () => {
  const l = setup(); const oldEpoch = l.status('ipad').exhibition.epoch;
  const s = start(l); const requestId = crypto.randomUUID();
  l.begin('ipad', s, 'user', 'old-job');
  l.nextExhibitionVisitor('ipad', requestId, oldEpoch);
  assert.throws(() => l.start('ipad', 'ip', 'late-start', oldEpoch), /exhibition_unavailable/);
  assert.throws(() => l.begin('ipad', s, 'tts', 'late-tts', 5, 'ticket'), /session_expired/);
  assert.throws(() => l.reserve('ipad', s, 'old-job', 'late-charge', 1), /session_expired/);
  const next = start(l);
  l.nextExhibitionVisitor('ipad', requestId, oldEpoch);
  assert.equal(l.status('ipad').session.id, next);
  assert.throws(() => l.nextExhibitionVisitor('ipad', crypto.randomUUID(), oldEpoch), /exhibition_stale/);
});
test('expiry, revocation and event stop never fall back to public admission', () => {
  for (const action of ['expiry', 'revoke', 'stop']) {
    let l = setup(); const s = start(l);
    if (action === 'expiry') l = new Ledger(l.state, Date.parse('2026-09-24T00:00:00+09:00'));
    if (action === 'revoke') l.revokeExhibitionDevice('ipad');
    if (action === 'stop') l.stopExhibition(eventId);
    assert.equal(l.status('ipad').exhibition.available, false);
    assert.throws(() => start(l), /exhibition_unavailable/);
    assert.throws(() => l.begin('ipad', s, 'user', 'j'), /session_expired|exhibition_unavailable/);
  }
});
test('waiting generates nothing, while card turns and bounded audio remain admitted', () => {
  const l = setup(); const s = start(l);
  assert.equal(allowExhibitionAutonomy(true, false), false);
  assert.equal(allowExhibitionAutonomy(true, true), true);
  assert.equal(allowExhibitionAutonomy(false, false), true);
  assert.throws(() => l.begin('ipad', s, 'autonomous', 'idle'), /exhibition_idle/);
  assert.equal(l.report().activeJobs, 0);
  for (let i = 0; i < 25; i++) { l.begin('ipad', s, 'transcribe', 'audio', 20); l.finish('audio'); }
  assert.throws(() => l.begin('ipad', s, 'transcribe', 'audio', 21), /audio_limit/);
  l.begin('ipad', s, 'card', 'card');
  assert.throws(() => l.begin('ipad', s, 'user', 'user'), /busy/);
});
test('handoff request survives reload and retries with exactly the same ID until acknowledged', () => {
  const data = new Map(); const storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  const request = prepareHandoff(storage, 1);
  assert.deepEqual(readHandoff(storage), request);
  assert.deepEqual(prepareHandoff(storage, 2), request);
  completeHandoff(storage); assert.equal(readHandoff(storage), null);
  assert.notEqual(prepareHandoff(storage, 2).requestId, request.requestId);
});
test('late public replies and buffered stream chunks cannot cross a participant handoff', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = Object.assign(new EventTarget(), { location: { search: '' } });
  globalThis.document = { hidden: false };
  try {
    const result = await build({ entryPoints: ['src/public/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
      define: { 'import.meta.env': '{"VITE_APP_MODE":"public"}' } });
    const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
    let release;
    globalThis.fetch = () => new Promise(done => { release = done; });
    api.activatePublic({ id: 'old', expires: Date.now() + 60000 });
    const old = api.publicFetch('/api/chat');
    api.pausePublic(); api.activatePublic({ id: 'new', expires: Date.now() + 60000 });
    release(Response.json({ text: 'old reply', ttsTicket: 'old ticket' }));
    await assert.rejects(old, { name: 'AbortError' });
    let streamController;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { streamController = c; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    const stream = await api.publicFetch('/api/chat');
    const reading = stream.text();
    api.pausePublic(); api.activatePublic({ id: 'next', expires: Date.now() + 60000 });
    streamController.enqueue(new TextEncoder().encode('{"type":"speech_unit","text":"old","ttsTicket":"old"}\n'));
    streamController.close();
    await assert.rejects(reading, { name: 'AbortError' });
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
    assert.equal((await api.publicFetch('/api/tts', { body: JSON.stringify({ text: 'old' }) })).status, 403);
    assert.equal(calls, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
