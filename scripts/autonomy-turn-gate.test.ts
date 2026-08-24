import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAutonomyTurnGateState,
  getAutonomyTurnGateWaitMs,
  isAutonomyTurnGateReady,
  sampleAutonomyQuietTime,
  transitionAutonomyTurnGate,
  type AutonomyTurnGateTiming,
} from '../src/conversation/autonomyTurnGate.js';

const TIMING: AutonomyTurnGateTiming = {
  initialAutonomyDelayMs: 4_000,
  autonomyQuietTimeMinMs: 8_000,
  autonomyQuietTimeMaxMs: 18_000,
};

function readyState(): ReturnType<typeof createAutonomyTurnGateState> {
  return transitionAutonomyTurnGate(
    createAutonomyTurnGateState(0, TIMING),
    { type: 'timer_expired', at: 4_000 },
    TIMING,
  );
}

test('initial quiet blocks a candidate until the four-second deadline', () => {
  const initial = createAutonomyTurnGateState(0, TIMING);
  assert.equal(initial.phase, 'initial_quiet');
  assert.equal(initial.nextEligibleAt, 4_000);
  assert.equal(isAutonomyTurnGateReady(initial), false);
  assert.equal(getAutonomyTurnGateWaitMs(initial, 3_999), 1);

  const ready = transitionAutonomyTurnGate(
    initial,
    { type: 'timer_expired', at: 4_000 },
    TIMING,
  );
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.nextEligibleAt, null);
});

test('initial quiet is not bypassed by an external event', () => {
  const initial = createAutonomyTurnGateState(0, TIMING);
  const next = transitionAutonomyTurnGate(
    initial,
    { type: 'external_event', event: 'card_change', at: 1_000 },
    TIMING,
  );
  assert.deepEqual(next, initial);
});

test('completed autonomous turns enter refractory for one sampled deadline', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const completed = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0,
  );
  assert.equal(completed.phase, 'refractory');
  assert.equal(completed.nextEligibleAt, 14_000);
  assert.equal(getAutonomyTurnGateWaitMs(completed, 7_000), 7_000);

  const unchanged = transitionAutonomyTurnGate(
    completed,
    { type: 'timer_expired', at: 7_001 },
    TIMING,
  );
  assert.deepEqual(unchanged, completed);

  const readyAgain = transitionAutonomyTurnGate(
    completed,
    { type: 'timer_expired', at: 14_000 },
    TIMING,
  );
  assert.equal(readyAgain.phase, 'ready');
  assert.equal(readyAgain.nextEligibleAt, null);
});

test('silent autonomous completion also enters refractory', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const completed = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 1,
  );
  assert.equal(completed.phase, 'refractory');
  assert.equal(completed.nextEligibleAt, 24_000);
});

test('internal reason updates do not change the refractory deadline', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const completed = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0.5,
  );
  const sameState = { ...completed };
  assert.deepEqual(sameState, completed);
  assert.equal(completed.nextEligibleAt, 19_000);
});

test('meaningful external events reopen refractory before its deadline', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const refractory = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0,
  );
  const reopened = transitionAutonomyTurnGate(
    refractory,
    { type: 'external_event', event: 'viewer_speech', at: 7_000 },
    TIMING,
  );
  assert.equal(reopened.phase, 'ready');
  assert.equal(reopened.nextEligibleAt, null);
});

test('external events during a turn reopen after completion', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const interrupted = transitionAutonomyTurnGate(
    running,
    { type: 'external_event', event: 'router_change', at: 5_500 },
    TIMING,
  );
  assert.equal(interrupted.phase, 'running');
  assert.equal(interrupted.reopenAfterTurn, true);

  const completed = transitionAutonomyTurnGate(
    interrupted,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0,
  );
  assert.equal(completed.phase, 'ready');
  assert.equal(completed.nextEligibleAt, null);
});

test('an aborted turn returns to ready without a refractory deadline', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const aborted = transitionAutonomyTurnGate(
    running,
    { type: 'turn_aborted', at: 5_100 },
    TIMING,
  );
  assert.equal(aborted.phase, 'ready');
  assert.equal(aborted.nextEligibleAt, null);
});

test('quiet-time sampling stays within the configured inclusive range', () => {
  assert.equal(sampleAutonomyQuietTime(TIMING, () => 0), 8_000);
  assert.equal(sampleAutonomyQuietTime(TIMING, () => 0.999), 17_990);
  assert.equal(sampleAutonomyQuietTime(TIMING, () => 1), 18_000);
});
