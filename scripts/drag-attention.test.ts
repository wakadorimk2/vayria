import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DragAttentionController,
  DRAG_ATTENTION_MAX_ACQUIRE_MS,
  DRAG_ATTENTION_MIN_DWELL_MS,
  DRAG_ATTENTION_SALIENCE,
  getDragAttentionReleaseHazard,
} from '../src/attention/dragAttentionController.js';

test('drag attention always starts with a guaranteed acquire', () => {
  const controller = new DragAttentionController();

  assert.deepEqual(controller.start(), {
    phase: 'acquire',
    elapsedMs: 0,
  });
  assert.equal(
    controller.update(DRAG_ATTENTION_MIN_DWELL_MS, () => 0).phase,
    'acquire',
  );
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
  assert.equal(controller.update(1, () => 0).phase, 'priority');
  assert.equal(DRAG_ATTENTION_SALIENCE, 0.85);
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
});

test('ending drag attention clears the controller', () => {
  const controller = new DragAttentionController();
  controller.start();
  controller.update(250, () => 1);

  assert.deepEqual(controller.end(), { phase: 'idle', elapsedMs: 0 });
});
