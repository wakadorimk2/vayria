import type { AttentionPosition } from '../performer/types.js';
import { Vector3 } from 'three';

export const VIEWER_GAZE_PROJECTION = {
  horizontalGain: 4.4,
  verticalGain: 3.6,
  maxHorizontalAngleDegrees: 30,
  maxVerticalAngleDegrees: 27,
} as const;

export const VIEWER_HEAD_ATTENTION = {
  followRatio: 0.5,
  maxHorizontalAngleDegrees: 8,
  maxVerticalAngleDegrees: 6,
} as const;

export interface ViewerHeadBias {
  yawDegrees: number;
  pitchDegrees: number;
}

export interface ViewerCameraBasis {
  position: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export function mapCameraAttentionToViewerTarget(
  camera: ViewerCameraBasis,
  eyePosition: Vector3,
  position: AttentionPosition,
  fovDegrees: number,
  aspect: number,
  target: Vector3,
): Vector3 {
  const cameraToEyeDistance = camera.position.distanceTo(eyePosition);
  const safeDistance =
    Number.isFinite(cameraToEyeDistance) && cameraToEyeDistance > 0
      ? cameraToEyeDistance
      : 1;
  const safeFovDegrees = Number.isFinite(fovDegrees)
    ? Math.max(1, Math.min(fovDegrees, 179))
    : 30;
  const safeAspect = Number.isFinite(aspect) ? Math.max(aspect, 0.1) : 1;
  const { horizontalAngle, verticalAngle } = getViewerAttentionAngles(
    position,
    safeFovDegrees,
    safeAspect,
  );
  const horizontalOffset = safeDistance * Math.tan(horizontalAngle);
  const verticalOffset = safeDistance * Math.tan(verticalAngle);

  // Place the target on the viewer side of the render camera.
  return target
    .copy(camera.position)
    .addScaledVector(camera.forward, -safeDistance)
    .addScaledVector(camera.right, horizontalOffset)
    .addScaledVector(camera.up, verticalOffset);
}

export function mapCameraAttentionToHeadBias(
  position: AttentionPosition,
  fovDegrees: number,
  aspect: number,
  attentionLevel: number,
): ViewerHeadBias {
  const safeFovDegrees = Number.isFinite(fovDegrees)
    ? Math.max(1, Math.min(fovDegrees, 179))
    : 30;
  const safeAspect = Number.isFinite(aspect) ? Math.max(aspect, 0.1) : 1;
  const { horizontalAngle, verticalAngle } = getViewerAttentionAngles(
    position,
    safeFovDegrees,
    safeAspect,
  );
  const safeAttentionLevel = clampLevel(attentionLevel);

  return {
    yawDegrees: clampDegrees(
      (horizontalAngle * 180) /
        Math.PI *
        VIEWER_HEAD_ATTENTION.followRatio *
        safeAttentionLevel,
      VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
    ),
    pitchDegrees: clampDegrees(
      (verticalAngle * 180) /
        Math.PI *
        VIEWER_HEAD_ATTENTION.followRatio *
        safeAttentionLevel,
      VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
    ),
  };
}

function getViewerAttentionAngles(
  position: AttentionPosition,
  fovDegrees: number,
  aspect: number,
): { horizontalAngle: number; verticalAngle: number } {
  const halfFovRadians = (fovDegrees * Math.PI) / 360;
  return {
    horizontalAngle: amplifyViewerAngle(
      Math.atan(
        (clampNormalized(position.x) * 2 - 1) *
          Math.tan(halfFovRadians) *
          aspect,
      ),
      VIEWER_GAZE_PROJECTION.horizontalGain,
      VIEWER_GAZE_PROJECTION.maxHorizontalAngleDegrees,
    ),
    verticalAngle: amplifyViewerAngle(
      Math.atan(
        (1 - clampNormalized(position.y) * 2) * Math.tan(halfFovRadians),
      ),
      VIEWER_GAZE_PROJECTION.verticalGain,
      VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees,
    ),
  };
}

function amplifyViewerAngle(
  angleRadians: number,
  gain: number,
  maxAngleDegrees: number,
): number {
  const safeGain = Number.isFinite(gain) ? Math.max(gain, 0) : 1;
  const safeMaxAngleDegrees = Number.isFinite(maxAngleDegrees)
    ? Math.max(maxAngleDegrees, 0)
    : 0;
  const maxAngleRadians = (safeMaxAngleDegrees * Math.PI) / 180;
  const amplifiedAngle = angleRadians * safeGain;
  return Math.max(
    -maxAngleRadians,
    Math.min(amplifiedAngle, maxAngleRadians),
  );
}

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(value, 1));
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}

function clampDegrees(value: number, maxDegrees: number): number {
  return Math.max(-maxDegrees, Math.min(value, maxDegrees));
}
