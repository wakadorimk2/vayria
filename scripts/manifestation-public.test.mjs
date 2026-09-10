import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { validatePr } from './staging-pr.mjs';
const bundle = await build({ entryPoints: ['worker/ledger.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { Ledger, initialState } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function setup() {
  const state = initialState(); state.limits.dayBudget = 10000000000; state.limits.monthBudget = 10000000000;
  state.limits.sessionSeconds = 3600;
  const ledger = new Ledger(state, 1000); ledger.start('v', 'ip', 's');
  return { state, ledger, event: { eventId: 'e', sessionId: 'local', generation: 0, clientId: 'c', cardId: 'chicken' } };
}
test('generation reserves once, coexists with conversation, persists and enforces visitor media ownership', () => {
  const { state, ledger, event } = setup();
  ledger.begin('v', 's', 'user', 'chat');
  ledger.manifestationBegin('v', 's', event, 'video');
  assert.throws(() => ledger.manifestationBegin('v', 's', event, 'other'), /duplicate_event/);
  assert.equal(state.manifestation.reservedMicrousd, 125000);
  ledger.manifestationComplete('v', 's', 'video', 'https://v3.fal.media/test.mp4');
  ledger.manifestationFinish('video', 'complete', { submit: 50 });
  const restored = new Ledger(JSON.parse(JSON.stringify(state)), 1100);
  assert.equal(restored.manifestationMedia('v', 'video'), 'https://v3.fal.media/test.mp4');
  assert.throws(() => restored.manifestationMedia('other', 'video'), /invalid_ticket/);
  restored.end('v', 's'); assert.throws(() => restored.manifestationMedia('v', 'video'), /session_expired/);
  assert.equal(restored.report().manifestation.reservedUsd, .125);
});
test('two simultaneous generations, failed requests retain cost and 20 per session limit', () => {
  const { ledger, state, event } = setup();
  ledger.manifestationBegin('v', 's', event, 'a');
  ledger.manifestationBegin('v', 's', { ...event, eventId: 'e2' }, 'b');
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'e3' }, 'c'), /busy/);
  ledger.manifestationFinish('a', 'provider_failure', {}); ledger.manifestationFinish('b', 'provider_failure', {});
  for (let i = 2; i < 20; i++) { ledger.manifestationBegin('v', 's', { ...event, eventId: 'event' + i }, 'j' + i); ledger.manifestationFinish('j' + i, 'provider_failure', {}); }
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'last' }, 'last'), /manifestation_limit/);
  assert.equal(state.manifestation.reservedMicrousd, 2500000);
});
test('global five dollar ceiling and existing daily budget reject before charging', () => {
  const { ledger, state, event } = setup();
  ledger.manifestationBegin('v', 's', event, 'a'); ledger.manifestationFinish('a', 'provider_failure', {});
  state.manifestation.reservedMicrousd = 5000000;
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'b' }, 'b'), /manifestation_budget/);
  state.manifestation.reservedMicrousd = 125000; state.limits.dayBudget = 1;
  assert.throws(() => ledger.manifestationBegin('v', 's', { ...event, eventId: 'b' }, 'b'));
  assert.equal(state.manifestation.reservedMicrousd, 125000);
});
test('expired generation cannot publish and staged PR guard rejects dirty/fork/stale revisions', () => {
  const { ledger, state, event } = setup(); ledger.manifestationBegin('v', 's', event, 'a');
  assert.throws(() => new Ledger(state, 12000).manifestationComplete('v', 's', 'a', 'url'), /job_expired/);
  const sha = 'a'.repeat(40); const repo = { full_name: 'wakadorimk2/vayria' };
  const pr = { state: 'open', head: { sha, repo }, base: { repo, ref: 'main' } };
  validatePr(pr, sha, sha, '');
  assert.throws(() => validatePr(pr, sha, sha, ' M file'));
  assert.throws(() => validatePr(pr, sha, 'b'.repeat(40), ''));
  assert.throws(() => validatePr({ ...pr, head: { sha, repo: { full_name: 'fork/repo' } } }, sha, sha, ''));
});
