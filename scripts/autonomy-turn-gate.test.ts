import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAutonomyTurnGateState,
  getAutonomyTurnGateWaitMs,
  isAutonomyTurnGateReady,
  readAutonomyTimingMode,
  readAutonomyTimingSnapshot,
  resolveAutonomyTimingMode,
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

test('baseline remains the default timing mode', () => {
  assert.equal(readAutonomyTimingMode(undefined), 'baseline');
  assert.equal(readAutonomyTimingMode('unknown'), 'baseline');
  assert.equal(readAutonomyTimingMode('monotonic'), 'monotonic');
  assert.equal(resolveAutonomyTimingMode('baseline', 'monotonic'), 'baseline');
  assert.equal(resolveAutonomyTimingMode('invalid', 'monotonic'), 'monotonic');
  assert.equal(resolveAutonomyTimingMode('invalid', 'invalid'), 'baseline');
});

test('monotonic readiness is zero through the minimum and quadratic in the window', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const refractory = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0.25,
    'monotonic',
  );

  assert.equal(refractory.phase, 'refractory');
  assert.equal(refractory.nextEligibleAt, 19_000);
  assert.deepEqual(
    readAutonomyTimingSnapshot(refractory, TIMING, 14_000, 'monotonic'),
    { elapsedSilenceMs: 8_000, readiness: 0, threshold: 0.25 },
  );
  assert.deepEqual(
    readAutonomyTimingSnapshot(refractory, TIMING, 19_000, 'monotonic'),
    { elapsedSilenceMs: 13_000, readiness: 0.25, threshold: 0.25 },
  );
  assert.deepEqual(
    readAutonomyTimingSnapshot(refractory, TIMING, 24_000, 'monotonic'),
    { elapsedSilenceMs: 18_000, readiness: 1, threshold: 0.25 },
  );
});

test('monotonic threshold is sampled once when refractory starts', () => {
  let calls = 0;
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const refractory = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => {
      calls += 1;
      return 1;
    },
    'monotonic',
  );

  assert.equal(calls, 1);
  assert.equal(refractory.readinessThreshold, 1);
  assert.equal(refractory.nextEligibleAt, 24_000);
  assert.equal(
    transitionAutonomyTurnGate(
      refractory,
      { type: 'timer_expired', at: 23_999 },
      TIMING,
      () => {
        calls += 1;
        return 0;
      },
      'monotonic',
    ),
    refractory,
  );
  assert.equal(calls, 1);

  const ready = transitionAutonomyTurnGate(
    refractory,
    { type: 'timer_expired', at: 24_000 },
    TIMING,
    () => {
      calls += 1;
      return 0;
    },
    'monotonic',
  );
  assert.equal(calls, 1);
  assert.equal(ready.phase, 'ready');
});

test('viewer speech restarts monotonic silence with a new fixed threshold', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const refractory = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0.25,
    'monotonic',
  );
  const restarted = transitionAutonomyTurnGate(
    refractory,
    { type: 'external_event', event: 'viewer_speech', at: 10_000 },
    TIMING,
    () => 0.81,
    'monotonic',
  );

  assert.equal(restarted.phase, 'refractory');
  assert.equal(restarted.quietStartedAt, 10_000);
  assert.equal(restarted.readinessThreshold, 0.81);
  assert.equal(restarted.nextEligibleAt, 27_000);
});

test('viewer speech restarts monotonic silence after an opportunity becomes ready', () => {
  const running = transitionAutonomyTurnGate(
    readyState(),
    { type: 'turn_started', at: 5_000 },
    TIMING,
  );
  const refractory = transitionAutonomyTurnGate(
    running,
    { type: 'turn_completed', at: 6_000 },
    TIMING,
    () => 0.25,
    'monotonic',
  );
  const ready = transitionAutonomyTurnGate(
    refractory,
    { type: 'timer_expired', at: 19_000 },
    TIMING,
    () => 0,
    'monotonic',
  );
  const restarted = transitionAutonomyTurnGate(
    ready,
    { type: 'external_event', event: 'viewer_speech', at: 20_000 },
    TIMING,
    () => 0.81,
    'monotonic',
  );

  assert.equal(restarted.phase, 'refractory');
  assert.equal(restarted.quietStartedAt, 20_000);
  assert.equal(restarted.readinessThreshold, 0.81);
  assert.equal(restarted.nextEligibleAt, 37_000);
});

test('a monotonic opportunity without a candidate waits without another timer', () => {
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
    'monotonic',
  );
  const ready = transitionAutonomyTurnGate(
    refractory,
    { type: 'timer_expired', at: 14_000 },
    TIMING,
    () => 1,
    'monotonic',
  );
  let randomCalls = 0;
  const skipped = transitionAutonomyTurnGate(
    ready,
    { type: 'opportunity_skipped', at: 14_000 },
    TIMING,
    () => {
      randomCalls += 1;
      return 1;
    },
    'monotonic',
  );

  assert.equal(randomCalls, 0);
  assert.deepEqual(skipped, {
    phase: 'waiting_candidate',
    nextEligibleAt: null,
    quietStartedAt: null,
    readinessThreshold: null,
    reopenAfterTurn: false,
  });
  assert.equal(getAutonomyTurnGateWaitMs(skipped, 14_000), null);

  const candidateAvailable = transitionAutonomyTurnGate(
    skipped,
    { type: 'candidate_available', at: 15_000 },
    TIMING,
    () => 1,
    'monotonic',
  );
  assert.equal(candidateAvailable.phase, 'refractory');
  assert.equal(candidateAvailable.quietStartedAt, 15_000);
  assert.equal(candidateAvailable.readinessThreshold, 1);
  assert.equal(candidateAvailable.nextEligibleAt, 33_000);

  const externalEvent = transitionAutonomyTurnGate(
    skipped,
    { type: 'external_event', event: 'card_change', at: 16_000 },
    TIMING,
    () => 0.25,
    'monotonic',
  );
  assert.equal(externalEvent.phase, 'refractory');
  assert.equal(externalEvent.quietStartedAt, 16_000);
  assert.equal(externalEvent.readinessThreshold, 0.25);
  assert.equal(externalEvent.nextEligibleAt, 29_000);
});

test('session reset clears monotonic readiness and restores initial quiet', () => {
  const reset = transitionAutonomyTurnGate(
    {
      phase: 'refractory',
      nextEligibleAt: 24_000,
      quietStartedAt: 6_000,
      readinessThreshold: 1,
      reopenAfterTurn: false,
    },
    { type: 'reset', at: 30_000 },
    TIMING,
    () => 0,
    'monotonic',
  );

  assert.deepEqual(reset, {
    phase: 'initial_quiet',
    nextEligibleAt: 34_000,
    quietStartedAt: null,
    readinessThreshold: null,
    reopenAfterTurn: false,
  });
});
