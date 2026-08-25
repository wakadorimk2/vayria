import { Vector3 } from 'three';
import {
  SPATIAL_TARGET_INVALID_GRACE_MS,
  type SpatialTargetResolutionReason,
} from '../attention/spatialTargetRegistry.js';
import type {
  ViewerHeadBias,
} from './attentionTarget.js';

export const SPATIAL_TARGET_WORLD_GRACE_MS =
  SPATIAL_TARGET_INVALID_GRACE_MS;

export type SpatialTargetWorldResolutionReason =
  | SpatialTargetResolutionReason
  | 'bridge-invalid';

export interface SpatialTargetWorldInput {
  readonly key: string;
  readonly now: number;
  readonly live: {
    readonly target: Vector3;
    readonly headBias: ViewerHeadBias;
  } | null;
  readonly liveValid: boolean;
  readonly liveReason: SpatialTargetResolutionReason;
  readonly invalidSince: number | null;
}

export interface SpatialTargetWorldResolution {
  readonly target: Vector3 | null;
  readonly headBias: ViewerHeadBias;
  readonly valid: boolean;
  readonly usingLastValid: boolean;
  readonly reason: SpatialTargetWorldResolutionReason;
}

interface CachedWorldTarget {
  readonly target: Vector3;
  readonly headBias: ViewerHeadBias;
  invalidSince: number | null;
}

/**
 * Keeps one last-valid world target per spatial selection during brief
 * viewport, stage, or ray-resolution failures.
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
        target: live.target.clone(),
        headBias: cloneHeadBias(live.headBias),
        invalidSince: null,
      });
      return createResolution(
        live.target.clone(),
        live.headBias,
        true,
        false,
        input.liveReason,
      );
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
          cached.target.clone(),
          cached.headBias,
          false,
          true,
          liveFinite ? input.liveReason : 'bridge-invalid',
        );
      }

      if (liveFinite) {
        this.entries.set(input.key, {
          target: live.target.clone(),
          headBias: cloneHeadBias(live.headBias),
          invalidSince: failureSince,
        });
        return createResolution(
          live.target.clone(),
          live.headBias,
          false,
          true,
          input.liveReason,
        );
      }
    }

    return createResolution(
      null,
      { yawDegrees: 0, pitchDegrees: 0 },
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
  target: Vector3 | null,
  headBias: ViewerHeadBias,
  valid: boolean,
  usingLastValid: boolean,
  reason: SpatialTargetWorldResolutionReason,
): SpatialTargetWorldResolution {
  return {
    target,
    headBias: cloneHeadBias(headBias),
    valid,
    usingLastValid,
    reason,
  };
}

function cloneHeadBias(headBias: ViewerHeadBias): ViewerHeadBias {
  return {
    yawDegrees: headBias.yawDegrees,
    pitchDegrees: headBias.pitchDegrees,
  };
}

function isFiniteLiveResult(value: {
  readonly target: Vector3;
  readonly headBias: ViewerHeadBias;
}): boolean {
  return (
    Number.isFinite(value.target.x) &&
    Number.isFinite(value.target.y) &&
    Number.isFinite(value.target.z) &&
    Number.isFinite(value.headBias.yawDegrees) &&
    Number.isFinite(value.headBias.pitchDegrees)
  );
}
