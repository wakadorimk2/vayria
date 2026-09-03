import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldScheduleAutonomousTalk } from '../src/conversation/useAutonomousTalk.js';

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
