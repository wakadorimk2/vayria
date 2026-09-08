import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
await mkdir('node_modules/.tmp/public-tests', { recursive: true });
for (const name of ['ledger', 'security']) {
  const source = (await readFile(`worker/${name}.ts`, 'utf8')).replace("'./ledger'", "'./ledger.mjs'");
  await writeFile(`node_modules/.tmp/public-tests/${name}.mjs`, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
}
const { Ledger, initialState, periods } = await import('../node_modules/.tmp/public-tests/ledger.mjs');
const { sign, verify, wavSeconds, boundedBody } = await import('../node_modules/.tmp/public-tests/security.mjs');
const now = Date.parse('2026-09-08T10:00:00+09:00');
function fresh() { return new Ledger(initialState(), now); }
function paid(l, visitor, id) { l.start(visitor, 'ip', id); l.begin(visitor, id, 'user', id); l.reserve(visitor, id, id, id, 1000); l.finish(id); l.end(visitor, id); }
test('reload and concurrent sequentialized starts reuse the reserved session', () => {
  const l = fresh(); const a = l.start('v', 'ip', 'a'); const b = l.start('v', 'ip', 'b');
  assert.equal(a.session.id, b.session.id); assert.equal(b.remainingDay, 1);
  l.end('v', 'a'); assert.equal(l.status('v').remainingDay, 2);
});
test('paid daily quota is retained and changing configuration does not reset it', () => {
  const l = fresh(); paid(l, 'v', 'a'); paid(l, 'v', 'b');
  assert.throws(() => l.start('v', 'ip', 'c'), /visitor_day_limit/);
  l.configure({ visitorDay: 3 }); assert.equal(l.start('v', 'ip', 'c').remainingDay, 0);
});
test('JST day and month boundaries retain monthly usage independently', () => {
  const l = new Ledger(initialState(), Date.parse('2026-09-30T23:59:00+09:00'));
  paid(l, 'v', 'a'); l.configure({ visitorMonth: 1 });
  assert.throws(() => l.start('v', 'ip', 'b'), /visitor_month_limit/);
  const next = new Ledger(l.state, Date.parse('2026-10-01T00:00:00+09:00'));
  assert.equal(next.status('v').remainingMonth, 1);
  assert.equal(periods(next.now).day, '2026-10-01');
});
test('unused expiration refunds reservation but paid expiration does not', () => {
  const l = fresh(); l.start('v', 'ip', 'a');
  const expired = new Ledger(l.state, now + 181000); assert.equal(expired.status('v').remainingDay, 2);
  paid(expired, 'v', 'b'); assert.equal(expired.status('v').remainingDay, 1);
  const removed = new Ledger(l.state, now + 2 * 86400000); assert.equal(Object.keys(removed.state.sessions).length, 0);
});
test('IP attempts are capped without consuming visitor sessions', () => {
  const l = fresh(); for (let i = 0; i < 10; i++) l.attempt('ip');
  assert.throws(() => l.attempt('ip'), /ip_rate_limit/); assert.equal(l.status('v').remainingDay, 2);
  new Ledger(l.state, now + 60000).attempt('ip');
});
test('budget reservation rejects a second request and unknown failures retain cost', () => {
  const l = fresh(); l.configure({ dayBudget: 10000 }); l.start('v', 'ip', 'a'); l.begin('v', 'a', 'user', 'j');
  l.reserve('v', 'a', 'j', 'c', 6000);
  assert.throws(() => l.reserve('v', 'a', 'j', 'd', 6000), /daily_budget/);
  l.finish('j'); assert.equal(l.report().dayYen, .006);
  l.settle('c', 2000); l.settle('c', 0); assert.equal(l.report().dayYen, .002);
});
test('global concurrency and same-session conversation overlap are rejected', () => {
  const l = fresh(); for (let i = 0; i < 5; i++) { l.start(`v${i}`, 'ip', `s${i}`); l.begin(`v${i}`, `s${i}`, 'user', `j${i}`); }
  assert.throws(() => l.begin('v0', 's0', 'card', 'other'), /busy/);
  l.start('v5', 'ip', 's5'); assert.throws(() => l.begin('v5', 's5', 'user', 'j5'), /busy/);
  l.finish('j0'); l.begin('v5', 's5', 'user', 'j5');
});
test('ticket replay and excessive audio duration never reach a charge reservation', () => {
  const l = fresh(); l.start('v', 'ip', 's');
  assert.throws(() => l.begin('v', 's', 'transcribe', 'j', 21), /audio_limit/);
  l.begin('v', 's', 'tts', 'j', 5, 'nonce'); l.finish('j');
  assert.throws(() => l.begin('v', 's', 'tts', 'k', 5, 'nonce'), /ticket_used/);
  assert.equal(Object.keys(l.state.charges).length, 0);
});
test('transcription stops when all user-generated replies are used', () => {
  const l = fresh(); l.start('v', 'ip', 's');
  for (let i = 0; i < 6; i++) { l.begin('v', 's', 'user', `j${i}`); l.finish(`j${i}`); }
  assert.throws(() => l.begin('v', 's', 'transcribe', 'audio', 1), /user_limit/);
  assert.equal(l.state.sessions.s.audioSeconds, 0);
});
test('signed cookies reject tampering, expiration and another secret', async () => {
  const secret = 'a'.repeat(32); const token = await sign({ id: 'visitor', exp: Date.now() + 60000 }, secret);
  assert.equal((await verify(token, secret)).id, 'visitor'); assert.equal(await verify(token + 'x', secret), null);
  assert.equal(await verify(token, 'b'.repeat(32)), null);
  assert.equal(await verify(await sign({ exp: 1 }, secret), secret), null);
});
test('invalid WAV and oversized payloads are refused', async () => {
  assert.throws(() => wavSeconds(new Uint8Array(44)), /invalid_audio/);
  await assert.rejects(() => boundedBody(new Request('https://test', { method: 'POST', body: '12345' }), 4), /request_too_large/);
});
