import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMERA_ATTENTION_CONFIG,
  getCameraAttentionConfidence,
  getUncertainEyePosition,
} from '../src/attention/attentionMath.js';
import {
  CameraTrackingController,
  type CameraTrackingFrame,
} from '../src/attention/cameraTrackingController.js';
import {
  AttentionVisualSmoother,
} from '../src/attention/attentionVisualSmoother.js';
import type { CameraAttentionSnapshot } from '../src/attention/cameraAttentionController.js';

function snapshot(
  updatedAt: number,
  position: CameraAttentionSnapshot['position'],
  confidence = position === null ? 0 : 1,
): CameraAttentionSnapshot {
  return { position, confidence, updatedAt };
}

function update(
  controller: CameraTrackingController,
  now: number,
  nextSnapshot: CameraAttentionSnapshot,
): CameraTrackingFrame {
  return controller.update({
    now,
    enabled: true,
    snapshot: nextSnapshot,
  });
}

test('camera tracking coasts, then softens only the eyes during uncertainty', () => {
  const controller = new CameraTrackingController();
  const position = { x: 0.75, y: 0.3 };

  const tracking = update(controller, 0, snapshot(1, position));
  assert.equal(tracking.state, 'Tracking');
  assert.deepEqual(tracking.eyePosition, position);
  assert.deepEqual(tracking.headPosition, position);
  assert.equal(tracking.focus.phase, 'focused');

  const stationary = update(controller, 50, snapshot(1, position));
  assert.equal(stationary.state, 'Tracking');
  assert.equal(stationary.focus.phase, 'focused');

  const coasting = update(controller, 100, snapshot(2, null));
  assert.equal(coasting.state, 'Coasting');
  assert.deepEqual(coasting.eyePosition, position);
  assert.deepEqual(coasting.headPosition, position);
  assert.equal(coasting.focus.phase, 'holding');

  const earlyUncertain = update(
    controller,
    CAMERA_ATTENTION_CONFIG.uncertainEyeStartMs + 50,
    snapshot(3, null),
  );
  assert.equal(earlyUncertain.state, 'Uncertain');
  assert.deepEqual(earlyUncertain.eyePosition, position);
  assert.deepEqual(earlyUncertain.headPosition, position);

  const uncertain = update(controller, 1_600, snapshot(4, null));
  assert.equal(uncertain.state, 'Uncertain');
  assert.ok(uncertain.eyePosition);
  assert.ok(uncertain.headPosition);
  assert.ok(uncertain.eyePosition.x < position.x);
  assert.equal(uncertain.headPosition.x, position.x);
  assert.equal(uncertain.focus.phase, 'uncertain');
  assert.ok(uncertain.focus.confidence > 0);
  assert.ok(uncertain.focus.confidence < 1);
});

test('lost attention releases, and reacquisition starts from the current posture', () => {
  const controller = new CameraTrackingController();
  update(controller, 0, snapshot(1, { x: 0.7, y: 0.4 }));

  const lost = update(
    controller,
    CAMERA_ATTENTION_CONFIG.lostMs,
    snapshot(2, null),
  );
  assert.equal(lost.state, 'Lost');
  assert.equal(lost.eyePosition, null);
  assert.equal(lost.headPosition, null);
  assert.deepEqual(lost.focus, {
    target: 'idle',
    phase: 'released',
    confidence: 0,
  });

  const reacquire = update(
    controller,
    CAMERA_ATTENTION_CONFIG.lostMs + 100,
    snapshot(3, { x: 0.25, y: 0.6 }),
  );
  assert.equal(reacquire.state, 'Reacquire');
  assert.equal(reacquire.focus.phase, 'reengaging');
  assert.ok(reacquire.focus.confidence >= 0.25);

  const tracking = update(
    controller,
    CAMERA_ATTENTION_CONFIG.lostMs +
      100 +
      CAMERA_ATTENTION_CONFIG.reacquireMs,
    snapshot(3, { x: 0.25, y: 0.6 }),
  );
  assert.equal(tracking.state, 'Tracking');
  assert.equal(tracking.focus.phase, 'focused');
});

test('attention confidence and uncertain position remain bounded', () => {
  const uncertain = getUncertainEyePosition(
    { x: 0.85, y: 0.15 },
    CAMERA_ATTENTION_CONFIG.lostMs - 1,
  );
  assert.ok(uncertain.x >= 0.15 && uncertain.x <= 0.85);
  assert.ok(uncertain.y >= 0.15 && uncertain.y <= 0.85);
  assert.ok(
    getCameraAttentionConfidence(800) >
      getCameraAttentionConfidence(1_600),
  );
  assert.equal(
    getCameraAttentionConfidence(CAMERA_ATTENTION_CONFIG.lostMs),
    0,
  );
});

test('visual smoothing removes worker cadence steps for eyes and head', () => {
  const smoother = new AttentionVisualSmoother();
  const first = smoother.update(0.016, {
    eyePosition: { x: 0.8, y: 0.3 },
    headPosition: { x: 0.8, y: 0.3 },
  });
  assert.ok(first.eyePosition);
  assert.ok(first.headPosition);
  assert.ok(first.eyePosition.x > 0.5 && first.eyePosition.x < 0.8);
  assert.equal(first.eyePosition.x, first.headPosition.x);

  const previousX = first.eyePosition.x;
  const second = smoother.update(0.016, {
    eyePosition: { x: 0.2, y: 0.7 },
    headPosition: { x: 0.2, y: 0.7 },
  });
  assert.ok(second.eyePosition);
  assert.ok(second.headPosition);
  assert.ok(second.eyePosition.x < previousX);
  assert.ok(second.eyePosition.x > 0.2);
  assert.equal(second.eyePosition.x, second.headPosition.x);
});
