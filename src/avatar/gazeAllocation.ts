import { Vector3 } from 'three';
import {
  VIEWER_HEAD_ATTENTION,
  VIEWER_GAZE_PROJECTION,
  VIEWER_NECK_ATTENTION,
  type ViewerHeadBias,
} from './attentionTarget.js';

export type GazeAllocationProfile =
  | 'viewer'
  | 'spatial'
  | 'game-chat'
  | 'soft-cue';

export interface EyeGazeEnvelope {
  readonly horizontalRatio: number;
  readonly upperRatio: number;
  readonly lowerRatio: number;
  readonly horizontalDegrees: number;
  readonly upperDegrees: number;
  readonly lowerDegrees: number;
  readonly softSaturationStart: number;
}

export const EYE_GAZE_ENVELOPE: EyeGazeEnvelope = {
  horizontalRatio: 0.6,
  upperRatio: 0.5,
  lowerRatio: 0.6,
  horizontalDegrees:
    VIEWER_GAZE_PROJECTION.maxHorizontalAngleDegrees * 0.6,
  upperDegrees: VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees * 0.5,
  lowerDegrees: VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees * 0.6,
  softSaturationStart: 0.75,
};

export interface GazeAllocationBasis {
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
}

export interface GazeAllocationInput {
  readonly eyePosition: Vector3;
  readonly neutralTarget: Vector3;
  readonly resolvedTarget: Vector3;
  readonly basis: GazeAllocationBasis;
  readonly profile?: GazeAllocationProfile;
}

export interface GazeAllocationResult {
  /** The target before the eye envelope is applied. */
  readonly rawTarget: Vector3;
  /** The target after the eye-only envelope is applied. */
  readonly eyeTarget: Vector3;
  readonly headProjection: ViewerHeadBias;
  readonly neckProjection: ViewerHeadBias;
  readonly rawEyeAngle: ViewerHeadBias;
  readonly eyeRadius: number;
}

const DEFAULT_PROFILE: GazeAllocationProfile = 'spatial';

/**
 * Allocates a resolved gaze demand between the eyes, head, and neck.
 *
 * The result is a projection heuristic. It does not select a target and it
 * does not change attention ownership.
 */
export function allocateGaze(
  input: GazeAllocationInput,
): GazeAllocationResult | null {
  if (
    !isFiniteVector(input.eyePosition) ||
    !isFiniteVector(input.neutralTarget) ||
    !isFiniteVector(input.resolvedTarget) ||
    !isFiniteVector(input.basis.forward) ||
    !isFiniteVector(input.basis.right) ||
    !isFiniteVector(input.basis.up)
  ) {
    return null;
  }

  const forward = input.basis.forward.clone();
  const rightBasis = input.basis.right.clone();
  const upBasis = input.basis.up.clone();
  if (
    !normalizeVector(forward) ||
    !normalizeVector(rightBasis) ||
    !normalizeVector(upBasis)
  ) {
    return null;
  }

  const neutralDirection = input.neutralTarget
    .clone()
    .sub(input.eyePosition);
  const referenceForward = neutralDirection.clone();
  if (!normalizeVector(referenceForward)) {
    referenceForward.copy(forward);
  }

  const referenceRight = rightBasis
    .clone()
    .addScaledVector(
      referenceForward,
      -rightBasis.dot(referenceForward),
    );
  if (!normalizeVector(referenceRight)) {
    referenceRight.copy(rightBasis);
  }

  const referenceUp = referenceRight
    .clone()
    .cross(referenceForward)
    .normalize();
  if (!isFiniteVector(referenceUp) || referenceUp.lengthSq() <= 0.000001) {
    return null;
  }
  if (referenceUp.dot(upBasis) < 0) referenceUp.negate();

  const rawDirection = input.resolvedTarget
    .clone()
    .sub(input.eyePosition);
  const hasReferenceDepth = neutralDirection.lengthSq() > 0.000001;
  const angularDirection = hasReferenceDepth
    ? rawDirection
    : input.resolvedTarget.clone().sub(input.neutralTarget);
  const forwardComponent = hasReferenceDepth
    ? rawDirection.dot(referenceForward)
    : 1;
  const rawYaw =
    angularDirection.lengthSq() <= 0.000001
      ? 0
      : Math.atan2(
          angularDirection.dot(referenceRight),
          forwardComponent,
        );
  const rawPitch =
    angularDirection.lengthSq() <= 0.000001
      ? 0
      : Math.atan2(
          angularDirection.dot(referenceUp),
          forwardComponent,
        );
  if (!Number.isFinite(rawYaw) || !Number.isFinite(rawPitch)) return null;

  const rawYawDegrees = toDegrees(rawYaw);
  const rawPitchDegrees = toDegrees(rawPitch);
  const verticalLimit =
    rawPitchDegrees >= 0
      ? EYE_GAZE_ENVELOPE.upperDegrees
      : EYE_GAZE_ENVELOPE.lowerDegrees;
  const eyeRadius = Math.sqrt(
    (rawYawDegrees / EYE_GAZE_ENVELOPE.horizontalDegrees) ** 2 +
      (rawPitchDegrees / verticalLimit) ** 2,
  );
  if (!Number.isFinite(eyeRadius)) return null;

  const eyeRadiusAfterSaturation = saturateEyeRadius(eyeRadius);
  const eyeScale =
    eyeRadius > 0.000001 ? eyeRadiusAfterSaturation / eyeRadius : 1;
  const eyeYawDegrees = rawYawDegrees * eyeScale;
  const eyePitchDegrees = rawPitchDegrees * eyeScale;

  const neutralDepth = neutralDirection.length();
  const depth =
    Number.isFinite(neutralDepth) && neutralDepth > 0.000001
      ? neutralDepth
      : 1;
  const eyeTarget = input.neutralTarget
    .clone()
    .addScaledVector(
      referenceRight,
      Math.tan(toRadians(eyeYawDegrees)) * depth,
    )
    .addScaledVector(
      referenceUp,
      Math.tan(toRadians(eyePitchDegrees)) * depth,
    );
  if (!isFiniteVector(eyeTarget)) return null;

  const headWeight = smoothstep(0.5, 1, eyeRadius);
  const neckWeight = smoothstep(0.75, 1.25, eyeRadius);
  const neckShare = 0.5 * neckWeight;
  const residualYaw = rawYawDegrees - eyeYawDegrees;
  const residualPitch = rawPitchDegrees - eyePitchDegrees;
  const profile = getProfile(input.profile ?? DEFAULT_PROFILE);
  const headProjection = {
    yawDegrees: clampDegrees(
      (rawYawDegrees * headWeight + residualYaw * (1 - neckShare)) *
        profile.headScale,
      VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
    ),
    pitchDegrees: clampDegrees(
      (rawPitchDegrees * headWeight + residualPitch * (1 - neckShare)) *
        profile.headScale,
      VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
    ),
  };
  const neckProjection = {
    yawDegrees: clampDegrees(
      residualYaw * neckShare * profile.neckScale,
      VIEWER_NECK_ATTENTION.maxHorizontalAngleDegrees,
    ),
    pitchDegrees: clampDegrees(
      residualPitch * neckShare * profile.neckScale,
      VIEWER_NECK_ATTENTION.maxVerticalAngleDegrees,
    ),
  };

  if (
    !isFiniteHeadBias(headProjection) ||
    !isFiniteHeadBias(neckProjection)
  ) {
    return null;
  }

  return {
    rawTarget: input.resolvedTarget.clone(),
    eyeTarget,
    headProjection,
    neckProjection,
    rawEyeAngle: {
      yawDegrees: rawYawDegrees,
      pitchDegrees: rawPitchDegrees,
    },
    eyeRadius,
  };
}

export const allocateGazeTarget = allocateGaze;

function getProfile(profile: GazeAllocationProfile): {
  headScale: number;
  neckScale: number;
} {
  switch (profile) {
    case 'viewer':
      return {
        headScale: VIEWER_HEAD_ATTENTION.followRatio,
        neckScale: 0.25,
      };
    case 'soft-cue':
      return { headScale: 0, neckScale: 0 };
    case 'game-chat':
    case 'spatial':
    default:
      return { headScale: 1, neckScale: 0.75 };
  }
}

function saturateEyeRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  if (radius <= EYE_GAZE_ENVELOPE.softSaturationStart) return radius;
  if (radius >= 1) return 1;

  const start = EYE_GAZE_ENVELOPE.softSaturationStart;
  const span = 1 - start;
  const t = Math.max(0, Math.min((radius - start) / span, 1));
  // Cubic Hermite interpolation keeps the value and slope continuous at the
  // knee, then eases the eye output into the envelope boundary.
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * start +
    h10 * span +
    h01 * 1 +
    h11 * 0
  );
}

function smoothstep(start: number, end: number, value: number): number {
  if (value <= start) return 0;
  if (value >= end) return 1;
  const t = (value - start) / (end - start);
  return t * t * (3 - 2 * t);
}

function normalizeVector(vector: Vector3): boolean {
  if (!isFiniteVector(vector) || vector.lengthSq() <= 0.000001) {
    return false;
  }
  vector.normalize();
  return isFiniteVector(vector);
}

function isFiniteVector(vector: Vector3): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}

function isFiniteHeadBias(value: ViewerHeadBias): boolean {
  return (
    Number.isFinite(value.yawDegrees) && Number.isFinite(value.pitchDegrees)
  );
}

function clampDegrees(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(value, limit));
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
