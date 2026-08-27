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
  /** Avatar head basis after the previous frame's gaze projection. */
  readonly headBasis?: GazeAllocationBasis;
  readonly handoffState?: GazeHandoffState;
  readonly profile?: GazeAllocationProfile;
}

export interface GazeHandoffState {
  readonly headActive: boolean;
  readonly neckActive: boolean;
}

export const DEFAULT_GAZE_HANDOFF_STATE: GazeHandoffState = {
  headActive: false,
  neckActive: false,
};

export interface GazeAllocationResult {
  /** The target before the eye envelope is applied. */
  readonly rawTarget: Vector3;
  /** The target after the eye-only envelope is applied. */
  readonly eyeTarget: Vector3;
  readonly headProjection: ViewerHeadBias;
  readonly neckProjection: ViewerHeadBias;
  /** Raw target angle in the stable camera/neutral basis. */
  readonly rawTargetAngle: ViewerHeadBias;
  /** Raw target angle relative to the projected avatar head. */
  readonly headRelativeAngle: ViewerHeadBias;
  readonly rawEyeAngle: ViewerHeadBias;
  /** Eye angle after the elliptical envelope and soft saturation. */
  readonly eyeAngle: ViewerHeadBias;
  /** Remaining angle after the eye allocation. */
  readonly residualAngle: ViewerHeadBias;
  readonly headContribution: ViewerHeadBias;
  readonly neckContribution: ViewerHeadBias;
  readonly eyeRadius: number;
  readonly handoffState: GazeHandoffState;
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

  const stableBasis = normalizeBasis(input.basis);
  if (!stableBasis) return null;
  const headBasis = input.headBasis
    ? normalizeBasis(input.headBasis)
    : stableBasis;
  const actuatorBasis = headBasis ?? stableBasis;

  const neutralDirection = input.neutralTarget
    .clone()
    .sub(input.eyePosition);
  const hasReferenceDepth = neutralDirection.lengthSq() > 0.000001;
  const rawDirection = hasReferenceDepth
    ? input.resolvedTarget.clone().sub(input.eyePosition)
    : input.resolvedTarget.clone().sub(input.neutralTarget);
  if (!isFiniteVector(rawDirection)) return null;

  const rawTargetAngle = getRelativeAngle(
    rawDirection,
    neutralDirection,
    stableBasis,
    hasReferenceDepth,
    true,
  );
  const headRelativeAngle = getRelativeAngle(
    rawDirection,
    neutralDirection,
    actuatorBasis,
    hasReferenceDepth,
    false,
  );
  if (!rawTargetAngle || !headRelativeAngle) return null;

  const rawYawDegrees = toDegrees(headRelativeAngle.yawRadians);
  const rawPitchDegrees = toDegrees(headRelativeAngle.pitchRadians);
  const rawTargetYawDegrees = toDegrees(rawTargetAngle.yawRadians);
  const rawTargetPitchDegrees = toDegrees(rawTargetAngle.pitchRadians);
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
      actuatorBasis.right,
      Math.tan(toRadians(eyeYawDegrees)) * depth,
    )
    .addScaledVector(
      actuatorBasis.up,
      Math.tan(toRadians(eyePitchDegrees)) * depth,
    );
  if (!isFiniteVector(eyeTarget)) return null;

  const residualYaw = rawYawDegrees - eyeYawDegrees;
  const residualPitch = rawPitchDegrees - eyePitchDegrees;
  const residualMagnitude = Math.hypot(residualYaw, residualPitch);
  const previousHandoffState = input.handoffState ?? DEFAULT_GAZE_HANDOFF_STATE;
  const handoffState = {
    headActive: previousHandoffState.headActive
      ? residualMagnitude >= GAZE_HANDOFF.headReleaseDegrees
      : residualMagnitude > GAZE_HANDOFF.headEnterDegrees,
    neckActive: previousHandoffState.neckActive
      ? residualMagnitude >= GAZE_HANDOFF.neckReleaseDegrees
      : residualMagnitude > GAZE_HANDOFF.neckEnterDegrees,
  };
  const headWeight = handoffState.headActive
    ? smoothstep(GAZE_HANDOFF.headEnterDegrees, 9, residualMagnitude)
    : 0;
  const neckWeight = handoffState.neckActive
    ? smoothstep(GAZE_HANDOFF.neckEnterDegrees, 12, residualMagnitude)
    : 0;
  const neckShare = 0.5 * neckWeight;
  const profile = getProfile(input.profile ?? DEFAULT_PROFILE);
  const headContribution = {
    yawDegrees:
      residualYaw * headWeight * (1 - neckShare) * profile.headScale,
    pitchDegrees:
      residualPitch * headWeight * (1 - neckShare) * profile.headScale,
  };
  const neckContribution = {
    yawDegrees: residualYaw * headWeight * neckShare * profile.neckScale,
    pitchDegrees: residualPitch * headWeight * neckShare * profile.neckScale,
  };
  const headProjection = {
    yawDegrees: clampDegrees(
      headContribution.yawDegrees,
      VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
    ),
    pitchDegrees: clampDegrees(
      headContribution.pitchDegrees,
      VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
    ),
  };
  const neckProjection = {
    yawDegrees: clampDegrees(
      neckContribution.yawDegrees,
      VIEWER_NECK_ATTENTION.maxHorizontalAngleDegrees,
    ),
    pitchDegrees: clampDegrees(
      neckContribution.pitchDegrees,
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
    rawTargetAngle: {
      yawDegrees: rawTargetYawDegrees,
      pitchDegrees: rawTargetPitchDegrees,
    },
    headRelativeAngle: {
      yawDegrees: rawYawDegrees,
      pitchDegrees: rawPitchDegrees,
    },
    rawEyeAngle: {
      yawDegrees: rawYawDegrees,
      pitchDegrees: rawPitchDegrees,
    },
    eyeAngle: {
      yawDegrees: eyeYawDegrees,
      pitchDegrees: eyePitchDegrees,
    },
    residualAngle: {
      yawDegrees: residualYaw,
      pitchDegrees: residualPitch,
    },
    headContribution: { ...headProjection },
    neckContribution: { ...neckProjection },
    eyeRadius,
    handoffState,
  };
}

export const allocateGazeTarget = allocateGaze;

export const GAZE_HANDOFF = {
  headEnterDegrees: 3,
  headReleaseDegrees: 2,
  neckEnterDegrees: 5,
  neckReleaseDegrees: 3,
} as const;

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

interface NormalizedGazeBasis {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

interface RelativeAngle {
  yawRadians: number;
  pitchRadians: number;
}

function normalizeBasis(
  basis: GazeAllocationBasis,
): NormalizedGazeBasis | null {
  const forward = basis.forward.clone();
  const right = basis.right.clone();
  const up = basis.up.clone();
  if (
    !normalizeVector(forward) ||
    !normalizeVector(right) ||
    !normalizeVector(up)
  ) {
    return null;
  }

  right.addScaledVector(forward, -right.dot(forward));
  if (!normalizeVector(right)) return null;
  up.copy(right).cross(forward).normalize();
  if (!isFiniteVector(up) || up.lengthSq() <= 0.000001) return null;
  if (up.dot(basis.up) < 0) up.negate();
  return { forward, right, up };
}

function getRelativeAngle(
  direction: Vector3,
  neutralDirection: Vector3,
  basis: NormalizedGazeBasis,
  hasReferenceDepth: boolean,
  subtractNeutralAngle: boolean,
): RelativeAngle | null {
  if (!isFiniteVector(direction) || !isFiniteVector(neutralDirection)) {
    return null;
  }

  if (!hasReferenceDepth) {
    return {
      yawRadians: Math.atan2(
        direction.dot(basis.right),
        1,
      ),
      pitchRadians: Math.atan2(
        direction.dot(basis.up),
        1,
      ),
    };
  }

  const directionYaw = Math.atan2(
    direction.dot(basis.right),
    direction.dot(basis.forward),
  );
  const directionPitch = Math.atan2(
    direction.dot(basis.up),
    direction.dot(basis.forward),
  );
  const neutralYaw = Math.atan2(
    neutralDirection.dot(basis.right),
    neutralDirection.dot(basis.forward),
  );
  const neutralPitch = Math.atan2(
    neutralDirection.dot(basis.up),
    neutralDirection.dot(basis.forward),
  );
  return {
    yawRadians: wrapRadians(
      subtractNeutralAngle ? directionYaw - neutralYaw : directionYaw,
    ),
    pitchRadians: wrapRadians(
      subtractNeutralAngle ? directionPitch - neutralPitch : directionPitch,
    ),
  };
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

function wrapRadians(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let wrapped = value;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}
