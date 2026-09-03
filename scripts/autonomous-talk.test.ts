import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areAutonomousHardGatesOpen,
  isCurrentAutonomousTurnAttempt,
  shouldScheduleAutonomousTalk,
} from '../src/conversation/useAutonomousTalk.js';

const READY_STATE = {
  hasCandidate: true,
  isBusy: false,
  isVoiceActivityActive: false,
  isLoopEnabled: true,
  isMuted: false,
  isReady: true,
  isVisible: true,
  isTurnGateReady: true,
};

test('a candidate is required before autonomous scheduling', () => {
  assert.equal(
    shouldScheduleAutonomousTalk({ ...READY_STATE, hasCandidate: false }),
    false,
  );
  assert.equal(shouldScheduleAutonomousTalk(READY_STATE), true);
});

test('viewer speech and STT processing block a new autonomous candidate', () => {
  assert.equal(
    shouldScheduleAutonomousTalk({
      ...READY_STATE,
      isVoiceActivityActive: true,
    }),
    false,
  );
});

test('the autonomy turn gate blocks a candidate while it is not ready', () => {
  assert.equal(
    shouldScheduleAutonomousTalk({
      ...READY_STATE,
      isTurnGateReady: false,
    }),
    false,
  );
});

test('busy, muted, hidden, or unready state still blocks scheduling', () => {
  for (const key of [
    'isBusy',
    'isMuted',
    'isReady',
    'isVisible',
  ] as const) {
    assert.equal(
      shouldScheduleAutonomousTalk({
        ...READY_STATE,
        [key]: key === 'isReady' || key === 'isVisible' ? false : true,
      }),
      false,
      key,
    );
  }
});

test('disabled loop preserves the router and operator hard gate', () => {
  assert.equal(
    shouldScheduleAutonomousTalk({
      ...READY_STATE,
      isLoopEnabled: false,
    }),
    false,
  );
});

test('candidate-independent opportunities still require every hard gate', () => {
  const opportunityState = {
    ...READY_STATE,
    hasCandidate: false,
    isTurnGateReady: false,
  };
  assert.equal(areAutonomousHardGatesOpen(opportunityState), true);
  for (const key of [
    'isBusy',
    'isVoiceActivityActive',
    'isMuted',
    'isLoopEnabled',
    'isReady',
    'isVisible',
  ] as const) {
    assert.equal(
      areAutonomousHardGatesOpen({
        ...opportunityState,
        [key]:
          key === 'isLoopEnabled' || key === 'isReady' || key === 'isVisible'
            ? false
            : true,
      }),
      false,
      key,
    );
  }
});

test('a reset or replacement invalidates an older autonomous turn attempt', () => {
  const previousAttempt = { generation: 1 };
  const nextAttempt = { generation: 2 };

  assert.equal(
    isCurrentAutonomousTurnAttempt(previousAttempt, previousAttempt, 1),
    true,
  );
  assert.equal(
    isCurrentAutonomousTurnAttempt(null, previousAttempt, 1),
    false,
  );
  assert.equal(
    isCurrentAutonomousTurnAttempt(nextAttempt, previousAttempt, 2),
    false,
  );
  assert.equal(
    isCurrentAutonomousTurnAttempt(previousAttempt, previousAttempt, 2),
    false,
  );
});
