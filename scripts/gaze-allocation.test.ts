import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import {
  EYE_GAZE_ENVELOPE,
  allocateGaze,
} from '../src/avatar/gazeAllocation.js';

const basis = {
  forward: new Vector3(0, 0, 1),
  right: new Vector3(1, 0, 0),
  up: new Vector3(0, 1, 0),
};

function targetAt(yawDegrees: number, pitchDegrees = 0): Vector3 {
  const yaw = (yawDegrees * Math.PI) / 180;
  const pitch = (pitchDegrees * Math.PI) / 180;
  return new Vector3(Math.tan(yaw), Math.tan(pitch), 1);
}

function allocate(
  yawDegrees: number,
  pitchDegrees = 0,
  profile: 'viewer' | 'spatial' | 'soft-cue' = 'spatial',
) {
  const result = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: targetAt(yawDegrees, pitchDegrees),
    basis,
    profile,
  });
  assert.ok(result);
  return result;
}

test('center keeps eye, head, and neck allocation at zero', () => {
  const result = allocate(0, 0);

  assert.deepEqual(result.rawEyeAngle, { yawDegrees: 0, pitchDegrees: 0 });
  assert.equal(result.eyeRadius, 0);
  assert.deepEqual(result.headProjection, { yawDegrees: 0, pitchDegrees: 0 });
  assert.deepEqual(result.neckProjection, { yawDegrees: 0, pitchDegrees: 0 });
  assert.deepEqual(result.eyeTarget.toArray(), [0, 0, 1]);
});

test('eye output uses the conservative elliptical envelope', () => {
  const right = allocate(45);
  const up = allocate(0, 45);
  const down = allocate(0, -45);
  const diagonal = allocate(13, 10);

  assert.ok(right.eyeTarget.x > 0);
  assert.ok(right.eyeTarget.x < targetAt(45).x);
  assert.ok(Math.abs(right.rawEyeAngle.yawDegrees) > EYE_GAZE_ENVELOPE.horizontalDegrees);
  assert.ok(up.eyeTarget.y > 0);
  assert.ok(down.eyeTarget.y < 0);
  assert.ok(diagonal.eyeRadius > 1);
  const eyeYaw =
    (Math.atan2(diagonal.eyeTarget.x, diagonal.eyeTarget.z) * 180) / Math.PI;
  const eyePitch =
    (Math.atan2(diagonal.eyeTarget.y, diagonal.eyeTarget.z) * 180) / Math.PI;
  assert.ok(
    Math.sqrt(
      (eyeYaw / EYE_GAZE_ENVELOPE.horizontalDegrees) ** 2 +
        (eyePitch / EYE_GAZE_ENVELOPE.upperDegrees) ** 2,
    ) <= 1.0001,
  );
});

test('soft saturation is monotonic and continuous at the knee', () => {
  const atKnee = allocate(EYE_GAZE_ENVELOPE.horizontalDegrees * 0.75);
  const aboveKnee = allocate(EYE_GAZE_ENVELOPE.horizontalDegrees * 0.9);
  const atBoundary = allocate(EYE_GAZE_ENVELOPE.horizontalDegrees);

  const kneeEyeAngle = Math.atan2(atKnee.eyeTarget.x, atKnee.eyeTarget.z);
  const aboveKneeEyeAngle = Math.atan2(
    aboveKnee.eyeTarget.x,
    aboveKnee.eyeTarget.z,
  );
  const boundaryEyeAngle = Math.atan2(
    atBoundary.eyeTarget.x,
    atBoundary.eyeTarget.z,
  );
  assert.ok(aboveKneeEyeAngle > kneeEyeAngle);
  assert.ok(boundaryEyeAngle > aboveKneeEyeAngle);
  assert.ok(
    boundaryEyeAngle <=
      (EYE_GAZE_ENVELOPE.horizontalDegrees * Math.PI) / 180 + 0.0001,
  );
});

test('head begins near the comfort radius and neck receives large residuals', () => {
  const belowHeadHandoff = allocate(8);
  const headHandoff = allocate(10);
  const sustained = allocate(30);

  assert.equal(belowHeadHandoff.headProjection.yawDegrees, 0);
  assert.ok(headHandoff.headProjection.yawDegrees > 0);
  assert.ok(sustained.neckProjection.yawDegrees > 0);
  assert.ok(Math.abs(sustained.headProjection.yawDegrees) <= 8);
  assert.ok(Math.abs(sustained.headProjection.pitchDegrees) <= 6);
  assert.ok(Math.abs(sustained.neckProjection.yawDegrees) <= 4);
  assert.ok(Math.abs(sustained.neckProjection.pitchDegrees) <= 3);
});

test('viewer and soft-cue profiles preserve their allocation contracts', () => {
  const viewer = allocate(12, 0, 'viewer');
  const spatial = allocate(12, 0, 'spatial');
  const viewerNeck = allocate(20, 0, 'viewer');
  const spatialNeck = allocate(20, 0, 'spatial');
  const softCue = allocate(30, 15, 'soft-cue');

  assert.ok(viewer.headProjection.yawDegrees < spatial.headProjection.yawDegrees);
  assert.ok(viewerNeck.neckProjection.yawDegrees < spatialNeck.neckProjection.yawDegrees);
  assert.deepEqual(softCue.headProjection, { yawDegrees: 0, pitchDegrees: 0 });
  assert.deepEqual(softCue.neckProjection, { yawDegrees: 0, pitchDegrees: 0 });
  assert.ok(Number.isFinite(softCue.eyeTarget.x));
  assert.ok(Number.isFinite(softCue.eyeTarget.y));
  assert.ok(Number.isFinite(softCue.eyeTarget.z));
});

test('invalid vectors return null', () => {
  const result = allocateGaze({
    eyePosition: new Vector3(Number.NaN, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: new Vector3(0, 0, 1),
    basis,
  });

  assert.equal(result, null);
});
