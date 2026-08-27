import { Vector3 } from 'three';
import {
  SPATIAL_TARGET_INVALID_GRACE_MS,
  type SpatialTargetResolutionReason,
} from '../attention/spatialTargetRegistry.js';
import type { ViewerHeadBias } from './attentionTarget.js';

export const SPATIAL_TARGET_WORLD_GRACE_MS =
  SPATIAL_TARGET_INVALID_GRACE_MS;

export type SpatialTargetWorldResolutionReason =
  | SpatialTargetResolutionReason
  | 'bridge-invalid';

export interface SpatialTargetWorldValue {
  /** The resolved world target before the eye envelope is applied. */
  readonly target: Vector3;
  readonly eyeTarget: Vector3;
  readonly headProjection: ViewerHeadBias;
  readonly neckProjection: ViewerHeadBias;
  readonly rawEyeAngle: ViewerHeadBias;
  readonly eyeRadius: number;
}

export interface SpatialTargetWorldInput {
  readonly key: string;
  readonly now: number;
  readonly live: SpatialTargetWorldValue | null;
  readonly liveValid: boolean;
  readonly liveReason: SpatialTargetResolutionReason;
  readonly invalidSince: number | null;
}

export interface SpatialTargetWorldResolution {
  readonly target: Vector3 | null;
  readonly eyeTarget: Vector3 | null;
  readonly headProjection: ViewerHeadBias;
  readonly neckProjection: ViewerHeadBias;
  readonly rawEyeAngle: ViewerHeadBias;
  readonly eyeRadius: number;
  readonly valid: boolean;
  readonly usingLastValid: boolean;
  readonly reason: SpatialTargetWorldResolutionReason;
}

interface CachedWorldTarget extends SpatialTargetWorldValue {
  invalidSince: number | null;
}

/**
 * Keeps one complete last-valid world projection per spatial selection and
 * allocation profile during brief viewport, stage, or ray failures.
 */
export class SpatialTargetWorldCache {
  private readonly entries = new Map<string, CachedWorldTarget>();

  resolve(input: SpatialTargetWorldInput): SpatialTargetWorldResolution {
    const now = Number.isFinite(input.now) ? input.now : 0;
    const live = input.live;
    const liveFinite = live !== null && isFiniteLiveResult(live);
    const cached = this.entries.get(input.key);

    if (liveFinite && input.liveValid) {
      this.entries.set(input.key, {
        ...cloneWorldValue(live),
        invalidSince: null,
      });
      return createResolution(live, true, false, input.liveReason);
    }

    const failureSince = input.invalidSince ?? now;
    if (cached) {
      cached.invalidSince =
        cached.invalidSince === null
          ? failureSince
          : Math.min(cached.invalidSince, failureSince);
    }

    const invalidSince = cached?.invalidSince ?? now;
    if (now - invalidSince <= SPATIAL_TARGET_WORLD_GRACE_MS) {
      if (cached) {
        return createResolution(
          cached,
          false,
          true,
          liveFinite ? input.liveReason : 'bridge-invalid',
        );
      }

      if (liveFinite) {
        this.entries.set(input.key, {
          ...cloneWorldValue(live),
          invalidSince: failureSince,
        });
        return createResolution(live, false, true, input.liveReason);
      }
    }

    return createResolution(
      null,
      false,
      false,
      liveFinite ? input.liveReason : 'bridge-invalid',
    );
  }

  clear(): void {
    this.entries.clear();
  }
}

function createResolution(
  value: SpatialTargetWorldValue | null,
  valid: boolean,
  usingLastValid: boolean,
  reason: SpatialTargetWorldResolutionReason,
): SpatialTargetWorldResolution {
  return {
    target: value?.target.clone() ?? null,
    eyeTarget: value?.eyeTarget.clone() ?? null,
    headProjection: cloneHeadProjection(value?.headProjection),
    neckProjection: cloneHeadProjection(value?.neckProjection),
    rawEyeAngle: cloneHeadProjection(value?.rawEyeAngle),
    eyeRadius: value && Number.isFinite(value.eyeRadius) ? value.eyeRadius : 0,
    valid,
    usingLastValid,
    reason,
  };
}

function cloneWorldValue(value: SpatialTargetWorldValue): SpatialTargetWorldValue {
  return {
    target: value.target.clone(),
    eyeTarget: value.eyeTarget.clone(),
    headProjection: cloneHeadProjection(value.headProjection),
    neckProjection: cloneHeadProjection(value.neckProjection),
    rawEyeAngle: cloneHeadProjection(value.rawEyeAngle),
    eyeRadius: value.eyeRadius,
  };
}

function cloneHeadProjection(
  headProjection: ViewerHeadBias | undefined,
): ViewerHeadBias {
  return {
    yawDegrees: headProjection?.yawDegrees ?? 0,
    pitchDegrees: headProjection?.pitchDegrees ?? 0,
  };
}

function isFiniteLiveResult(value: SpatialTargetWorldValue): boolean {
  return (
    isFiniteVector(value.target) &&
    isFiniteVector(value.eyeTarget) &&
    isFiniteHeadProjection(value.headProjection) &&
    isFiniteHeadProjection(value.neckProjection) &&
    isFiniteHeadProjection(value.rawEyeAngle) &&
    Number.isFinite(value.eyeRadius)
  );
}

function isFiniteVector(value: Vector3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function isFiniteHeadProjection(value: ViewerHeadBias): boolean {
  return (
    Number.isFinite(value.yawDegrees) && Number.isFinite(value.pitchDegrees)
  );
}
