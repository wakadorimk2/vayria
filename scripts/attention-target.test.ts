import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  mapCameraAttentionToHeadBias,
  mapCameraAttentionToViewerTarget,
  VIEWER_GAZE_PROJECTION,
  VIEWER_HEAD_ATTENTION,
} from '../src/avatar/attentionTarget.js';

function createCameraBasis(aspect = 0.75): {
  basis: {
    position: Vector3;
    forward: Vector3;
    right: Vector3;
    up: Vector3;
  };
  camera: PerspectiveCamera;
} {
  const camera = new PerspectiveCamera(30, aspect, 0.01, 50);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return {
    camera,
    basis: {
      position: camera.position,
      forward: camera.getWorldDirection(new Vector3()),
      right: new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize(),
      up: new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize(),
    },
  };
}

test('camera center targets the viewer side of the render camera', () => {
  const { basis, camera } = createCameraBasis();
  const target = mapCameraAttentionToViewerTarget(
    basis,
    new Vector3(0, 0, 0),
    { x: 0.5, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  assert.ok(target.z > camera.position.z);
  assert.ok(Math.abs(target.x) < 0.0001);
  assert.ok(Math.abs(target.y) < 0.0001);
});

test('camera horizontal movement maps to the camera right vector', () => {
  const { basis, camera } = createCameraBasis();
  const eye = new Vector3(0, 0, 0);
  const left = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.15, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const right = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.85, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  assert.ok(right.x > left.x);
});

test('camera vertical movement maps to the camera up vector', () => {
  const { basis, camera } = createCameraBasis();
  const eye = new Vector3(0, 0, 0);
  const top = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.5, y: 0.15 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const bottom = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.5, y: 0.85 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  assert.ok(top.y > bottom.y);
});

test('edge attention applies the configured perceptual gain and angle caps', () => {
  const { basis, camera } = createCameraBasis();
  const eye = new Vector3(0, 0, 0);
  const center = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.5, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const right = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.15, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const bottom = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.5, y: 0.85 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const targetDepth = center.distanceTo(camera.position);
  const horizontalAngle = Math.atan2(
    Math.abs(right.clone().sub(center).dot(basis.right)),
    targetDepth,
  );
  const verticalAngle = Math.atan2(
    Math.abs(bottom.clone().sub(center).dot(basis.up)),
    targetDepth,
  );
  const halfFovRadians = (camera.fov * Math.PI) / 360;
  const baseHorizontalAngle = Math.atan(
    0.7 * Math.tan(halfFovRadians) * camera.aspect,
  );
  const baseVerticalAngle = Math.atan(0.7 * Math.tan(halfFovRadians));
  const expectedHorizontalAngle = Math.min(
    baseHorizontalAngle * VIEWER_GAZE_PROJECTION.horizontalGain,
    (VIEWER_GAZE_PROJECTION.maxHorizontalAngleDegrees * Math.PI) / 180,
  );
  const expectedVerticalAngle = Math.min(
    baseVerticalAngle * VIEWER_GAZE_PROJECTION.verticalGain,
    (VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees * Math.PI) / 180,
  );

  assert.ok(Math.abs(horizontalAngle - expectedHorizontalAngle) < 0.000001);
  assert.ok(Math.abs(verticalAngle - expectedVerticalAngle) < 0.000001);
  assert.ok(
    horizontalAngle <=
      (VIEWER_GAZE_PROJECTION.maxHorizontalAngleDegrees * Math.PI) / 180,
  );
  assert.ok(
    verticalAngle <=
      (VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees * Math.PI) / 180,
  );
});

test('attention at the screen corners remains finite and directional', () => {
  const { basis, camera } = createCameraBasis();
  const eye = new Vector3(0, 0, 0);
  const corner = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.15, y: 0.15 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const center = mapCameraAttentionToViewerTarget(
    basis,
    eye,
    { x: 0.5, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );

  assert.ok(corner.toArray().every(Number.isFinite));
  assert.ok(corner.clone().sub(center).dot(basis.right) < 0);
  assert.ok(corner.clone().sub(center).dot(basis.up) > 0);
});

test('head attention follows the corrected viewer direction at half gain', () => {
  const right = mapCameraAttentionToHeadBias({ x: 0.65, y: 0.5 }, 30, 0.75, 1);
  const left = mapCameraAttentionToHeadBias({ x: 0.35, y: 0.5 }, 30, 0.75, 1);
  const top = mapCameraAttentionToHeadBias({ x: 0.5, y: 0.35 }, 30, 0.75, 1);
  const bottom = mapCameraAttentionToHeadBias(
    { x: 0.5, y: 0.65 },
    30,
    0.75,
    1,
  );
  const halfFovRadians = (30 * Math.PI) / 360;
  const eyeAngleDegrees =
    (Math.atan(0.3 * Math.tan(halfFovRadians) * 0.75) *
      VIEWER_GAZE_PROJECTION.horizontalGain *
      180) /
    Math.PI;

  assert.ok(right.yawDegrees > 0);
  assert.ok(left.yawDegrees < 0);
  assert.ok(top.pitchDegrees > 0);
  assert.ok(bottom.pitchDegrees < 0);
  assert.ok(
    Math.abs(
      right.yawDegrees -
        eyeAngleDegrees * VIEWER_HEAD_ATTENTION.followRatio,
    ) < 0.000001,
  );
  assert.equal(
    mapCameraAttentionToHeadBias({ x: 0.65, y: 0.5 }, 30, 0.75, 0).yawDegrees,
    0,
  );
});

test('head attention respects natural angle caps and finite corner input', () => {
  const edge = mapCameraAttentionToHeadBias({ x: 0.15, y: 0.85 }, 30, 0.75, 1);
  const corner = mapCameraAttentionToHeadBias(
    { x: 0.15, y: 0.15 },
    30,
    0.75,
    1,
  );
  const center = mapCameraAttentionToHeadBias({ x: 0.5, y: 0.5 }, 30, 0.75, 1);

  assert.equal(
    Math.abs(edge.yawDegrees),
    VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
  );
  assert.equal(
    Math.abs(edge.pitchDegrees),
    VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
  );
  assert.ok(Object.values(corner).every(Number.isFinite));
  assert.deepEqual(center, { yawDegrees: 0, pitchDegrees: 0 });
});

test('eye position changes the resulting viewer direction', () => {
  const { basis, camera } = createCameraBasis();
  const centeredTarget = mapCameraAttentionToViewerTarget(
    basis,
    new Vector3(0, 0, 0),
    { x: 0.5, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  const offsetEyeTarget = mapCameraAttentionToViewerTarget(
    basis,
    new Vector3(0.3, 0.2, 0),
    { x: 0.5, y: 0.5 },
    camera.fov,
    camera.aspect,
    new Vector3(),
  );
  assert.notDeepEqual(offsetEyeTarget.toArray(), centeredTarget.toArray());
});
