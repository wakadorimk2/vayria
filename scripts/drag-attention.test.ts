import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DragAttentionController,
  DRAG_ATTENTION_MAX_ACQUIRE_MS,
  DRAG_ATTENTION_MAX_GAZE_STRENGTH,
  DRAG_ATTENTION_MIN_GAZE_STRENGTH,
  DRAG_ATTENTION_MIN_DWELL_MS,
  DRAG_VIEWER_CHECK_IN_MAX_DURATION_MS,
  DRAG_VIEWER_CHECK_IN_MIN_DURATION_MS,
  DRAG_VIEWER_CHECK_IN_START_MS,
  getDragAttentionReleaseHazard,
} from '../src/attention/dragAttentionController.js';

test('drag attention always starts with a guaranteed acquire', () => {
  const controller = new DragAttentionController();

  assert.deepEqual(controller.start(), {
    phase: 'acquire',
    elapsedMs: 0,
    gazeStrength: 0.55,
    attentionEnergy: 0.55,
    viewerCheckIn: false,
  });
  assert.equal(
    controller.update(DRAG_ATTENTION_MIN_DWELL_MS, () => 0).phase,
    'acquire',
  );
  assert.ok(controller.snapshot().gazeStrength < 0.55);
  assert.ok(controller.snapshot().gazeStrength >= 0.33);
});

test('release hazard rises across the configured dwell windows', () => {
  assert.equal(getDragAttentionReleaseHazard(199), 0);
  assert.equal(getDragAttentionReleaseHazard(200), 0.5);
  assert.equal(getDragAttentionReleaseHazard(499), 0.5);
  assert.equal(getDragAttentionReleaseHazard(500), 1.5);
  assert.equal(getDragAttentionReleaseHazard(799), 1.5);
  assert.equal(getDragAttentionReleaseHazard(800), 4);
});

test('a release can occur after minimum dwell, but never before it', () => {
  const controller = new DragAttentionController();
  controller.start();

  assert.equal(
    controller.update(DRAG_ATTENTION_MIN_DWELL_MS, () => 0).phase,
    'acquire',
  );
  const priority = controller.update(1, () => 0);
  assert.equal(priority.phase, 'priority');
  assert.ok(
    priority.gazeStrength >= DRAG_ATTENTION_MIN_GAZE_STRENGTH &&
      priority.gazeStrength <= DRAG_ATTENTION_MAX_GAZE_STRENGTH,
  );
  assert.equal(priority.attentionEnergy, priority.gazeStrength);
});

test('priority gaze strength changes smoothly inside the bounded range', () => {
  const controller = new DragAttentionController();
  controller.start();
  controller.update(DRAG_ATTENTION_MIN_DWELL_MS + 1, () => 0);

  const before = controller.snapshot().gazeStrength;
  const after = controller.update(50, () => 0, 600).gazeStrength;

  assert.notEqual(after, before);
  assert.ok(
    after >= DRAG_ATTENTION_MIN_GAZE_STRENGTH &&
      after <= DRAG_ATTENTION_MAX_GAZE_STRENGTH,
  );
  assert.ok(Math.abs(after - before) < 0.2);

  const refreshed = controller.update(300, () => 1, 0).gazeStrength;
  assert.ok(
    refreshed >= DRAG_ATTENTION_MIN_GAZE_STRENGTH &&
      refreshed <= DRAG_ATTENTION_MAX_GAZE_STRENGTH,
  );
  assert.ok(refreshed < after);
});

test('the safety maximum releases acquire when random samples never hit', () => {
  const controller = new DragAttentionController();
  controller.start();

  const snapshot = controller.update(
    DRAG_ATTENTION_MAX_ACQUIRE_MS,
    () => 1,
  );

  assert.equal(snapshot.phase, 'priority');
  assert.equal(snapshot.elapsedMs, DRAG_ATTENTION_MAX_ACQUIRE_MS);
  assert.ok(
    snapshot.gazeStrength >= DRAG_ATTENTION_MIN_GAZE_STRENGTH &&
      snapshot.gazeStrength <= DRAG_ATTENTION_MAX_GAZE_STRENGTH,
  );
});

test('ending drag attention clears the controller', () => {
  const controller = new DragAttentionController();
  controller.start();
  controller.update(250, () => 1);

  assert.deepEqual(controller.end(), {
    phase: 'idle',
    elapsedMs: 0,
    gazeStrength: 0,
    attentionEnergy: 0,
    viewerCheckIn: false,
  });
});

test('long drags briefly check the viewer and then resume card gaze', () => {
  const controller = new DragAttentionController();
  controller.start();
  controller.update(DRAG_ATTENTION_MAX_ACQUIRE_MS, () => 1);

  const before = controller.update(
    DRAG_VIEWER_CHECK_IN_START_MS - DRAG_ATTENTION_MAX_ACQUIRE_MS - 1,
    () => 0,
  );
  assert.equal(before.viewerCheckIn, false);

  const checking = controller.update(1, () => 0);
  assert.equal(checking.viewerCheckIn, true);

  const resumed = controller.update(
    DRAG_VIEWER_CHECK_IN_MAX_DURATION_MS,
    () => 0,
  );
  assert.equal(resumed.viewerCheckIn, false);
  assert.ok(
    checking.elapsedMs >= DRAG_VIEWER_CHECK_IN_START_MS &&
      checking.elapsedMs <=
        DRAG_VIEWER_CHECK_IN_START_MS +
          DRAG_VIEWER_CHECK_IN_MAX_DURATION_MS,
  );
  assert.ok(
    DRAG_VIEWER_CHECK_IN_MIN_DURATION_MS <=
      DRAG_VIEWER_CHECK_IN_MAX_DURATION_MS,
  );
});
