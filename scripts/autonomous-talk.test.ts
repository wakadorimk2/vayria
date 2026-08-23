import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldScheduleAutonomousTalk } from '../src/conversation/useAutonomousTalk.js';

const READY_STATE = {
  isBusy: false,
  isVoiceActivityActive: false,
  isLoopEnabled: true,
  isWaitingForViewer: false,
  isMuted: false,
  isReady: true,
  isVisible: true,
};

test('microphone readiness does not disable an idle autonomous candidate', () => {
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

test('busy, settled, muted, hidden, or unready state still blocks scheduling', () => {
  for (const key of [
    'isBusy',
    'isWaitingForViewer',
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
