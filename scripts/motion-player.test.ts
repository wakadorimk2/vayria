import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMotionExitWeight,
  MOTION_EXIT_BLEND_DURATION_MS,
} from '../src/avatar/motion/motionPlayer.js';

test('VRMA exit weight blends to idle over 300ms', () => {
  assert.equal(MOTION_EXIT_BLEND_DURATION_MS, 300);
  assert.equal(getMotionExitWeight(-1), 1);
  assert.equal(getMotionExitWeight(0), 1);
  assert.equal(getMotionExitWeight(150), 0.5);
  assert.equal(getMotionExitWeight(300), 0);
  assert.equal(getMotionExitWeight(600), 0);
});
