import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D, Quaternion, Vector3 } from 'three';
import {
  EYE_GAZE_ENVELOPE,
  allocateGaze,
} from '../src/avatar/gazeAllocation.js';
import { GazeProjectionFeedback } from '../src/avatar/gazeProjectionFeedback.js';

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
    neutralBasis: basis,
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

test('eye-to-target angles use the forward depth and remain near frontal', () => {
  const result = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 0),
    resolvedTarget: new Vector3(0.03, -0.39, 2.28),
    neutralBasis: basis,
  });

  assert.ok(result);
  const expectedYaw =
    (Math.atan2(0.03, 2.28) * 180) / Math.PI;
  const expectedPitch =
    (Math.atan2(-0.39, Math.hypot(0.03, 2.28)) * 180) / Math.PI;
  assert.ok(Math.abs(result.rawTargetAngle.yawDegrees - expectedYaw) < 0.01);
  assert.ok(
    Math.abs(result.rawTargetAngle.pitchDegrees - expectedPitch) < 0.01,
  );
  assert.deepEqual(result.targetEyeVector.toArray(), [0.03, -0.39, 2.28]);
  assert.ok(result.normalizedDirection.z > 0.98);
  assert.ok(result.eyeTarget.z > 0);
  assert.ok(result.eyeTarget.z < 1.01);
});

test('pitch uses horizontal depth instead of only the forward component', () => {
  const result = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 0),
    resolvedTarget: new Vector3(1, 1, 1),
    neutralBasis: basis,
  });

  assert.ok(result);
  const expectedPitch =
    (Math.atan2(1, Math.hypot(1, 1)) * 180) / Math.PI;
  assert.ok(
    Math.abs(result.rawTargetAngle.pitchDegrees - expectedPitch) < 0.01,
  );
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
  const belowHeadHandoff = allocate(12);
  const headHandoff = allocate(22);
  const sustained = allocate(30);

  assert.equal(belowHeadHandoff.headProjection.yawDegrees, 0);
  assert.ok(headHandoff.headProjection.yawDegrees > 0);
  assert.ok(sustained.neckProjection.yawDegrees > 0);
  assert.ok(Math.abs(sustained.headProjection.yawDegrees) <= 8);
  assert.ok(Math.abs(sustained.headProjection.pitchDegrees) <= 6);
  assert.ok(Math.abs(sustained.neckProjection.yawDegrees) <= 4);
  assert.ok(Math.abs(sustained.neckProjection.pitchDegrees) <= 3);
});

test('head-relative demand decreases when the head turns toward the target', () => {
  const target = targetAt(20);
  const turnedHeadBasis = {
    forward: new Vector3(0, 0, 1).applyAxisAngle(
      new Vector3(0, 1, 0),
      (8 * Math.PI) / 180,
    ),
    right: new Vector3(1, 0, 0).applyAxisAngle(
      new Vector3(0, 1, 0),
      (8 * Math.PI) / 180,
    ),
    up: new Vector3(0, 1, 0),
  };
  const result = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: target,
    neutralBasis: basis,
    headBasis: turnedHeadBasis,
  });

  assert.ok(result);
  assert.ok(result.rawTargetAngle.yawDegrees > result.headRelativeAngle.yawDegrees);
  assert.ok(Math.abs(result.headRelativeAngle.yawDegrees - 12) < 0.01);
});

test('head projection uses the eye residual instead of re-adding raw demand', () => {
  const result = allocate(30);

  assert.ok(result.residualAngle.yawDegrees > 0);
  assert.ok(result.headProjection.yawDegrees <= result.residualAngle.yawDegrees);
  assert.ok(result.headProjection.yawDegrees < result.rawEyeAngle.yawDegrees);
  assert.equal(result.headContribution.yawDegrees, result.headProjection.yawDegrees);
  assert.equal(result.neckContribution.yawDegrees, result.neckProjection.yawDegrees);
});

test('handoff thresholds hold state through a small residual decrease', () => {
  const acquired = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: targetAt(25),
    neutralBasis: basis,
  });
  assert.ok(acquired);
  assert.equal(acquired.handoffState.headActive, true);

  const held = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: targetAt(20.5),
    neutralBasis: basis,
    handoffState: acquired.handoffState,
  });
  assert.ok(held);
  assert.equal(held.handoffState.headActive, true);

  const released = allocateGaze({
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 1),
    resolvedTarget: targetAt(12),
    neutralBasis: basis,
    handoffState: held.handoffState,
  });
  assert.ok(released);
  assert.equal(released.handoffState.headActive, false);
});

test('gaze feedback applies only the previous gaze offset to the head basis', () => {
  const head = new Object3D();
  head.updateMatrixWorld(true);
  const output = {
    forward: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
  };
  const feedback = new GazeProjectionFeedback();
  const neutralBasis = feedback.createNeutralBasis(head, null, output);
  assert.ok(neutralBasis);
  const neutralForward = neutralBasis.forward.clone();

  feedback.set({
    head: { yawDegrees: 8, pitchDegrees: 0 },
    neck: { yawDegrees: 0, pitchDegrees: 0 },
  });
  const projectedBasis = feedback.createHeadBasis(head, null, output);
  assert.ok(projectedBasis);
  assert.ok(projectedBasis.forward.distanceTo(neutralForward) > 0.01);

  feedback.reset();
  const resetBasis = feedback.createHeadBasis(head, null, output);
  assert.ok(resetBasis);
  assert.ok(resetBasis.forward.distanceTo(neutralForward) < 0.0001);
});

test('gaze feedback uses the VRM face-front rotation for the neutral basis', () => {
  const head = new Object3D();
  head.updateMatrixWorld(true);
  const output = {
    forward: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
  };
  const feedback = new GazeProjectionFeedback();
  const faceFrontProvider = {
    getFaceFrontQuaternion(target: Quaternion) {
      return target.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    },
  };

  const result = feedback.createNeutralBasis(
    head,
    faceFrontProvider,
    output,
  );

  assert.ok(result);
  assert.ok(result.forward.z < -0.99);
  assert.ok(result.right.x < -0.99);
  assert.ok(result.up.y > 0.99);
});

test('viewer and soft-cue profiles preserve their allocation contracts', () => {
  const viewer = allocate(22, 0, 'viewer');
  const spatial = allocate(22, 0, 'spatial');
  const viewerNeck = allocate(25, 0, 'viewer');
  const spatialNeck = allocate(25, 0, 'spatial');
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
    neutralBasis: basis,
  });

  assert.equal(result, null);
});
