import { Vector3 } from 'three';

export const SPATIAL_TARGET_OUTPUT_TIMING = {
  eyeResponseMs: 120,
  headResponseMs: 350,
  neckResponseMs: 700,
} as const;

export interface SpatialHeadProjection {
  yawDegrees: number;
  pitchDegrees: number;
}

/**
 * Smooths resolved spatial output without changing the resolved target.
 * The resolved target remains available for ownership and diagnostics.
 */
export class SpatialTargetOutputSmoother {
  private readonly currentTarget = new Vector3();
  private initialized = false;

  update(
    desiredTarget: Vector3,
    deltaSeconds: number,
    responseMs: number,
    output: Vector3,
  ): Vector3 {
    if (!isFiniteVector(desiredTarget)) {
      return this.initialized
        ? output.copy(this.currentTarget)
        : output.set(0, 0, 0);
    }

    if (!this.initialized) {
      this.currentTarget.copy(desiredTarget);
      this.initialized = true;
    } else {
      this.currentTarget.lerp(
        desiredTarget,
        responseFactor(deltaSeconds, responseMs),
      );
    }
    return output.copy(this.currentTarget);
  }

  reset(initialTarget?: Vector3): void {
    if (initialTarget && isFiniteVector(initialTarget)) {
      this.currentTarget.copy(initialTarget);
      this.initialized = true;
      return;
    }
    this.currentTarget.set(0, 0, 0);
    this.initialized = false;
  }
}

export class SpatialHeadProjectionSmoother {
  private current: SpatialHeadProjection = {
    yawDegrees: 0,
    pitchDegrees: 0,
  };
  private initialized = false;

  update(
    desired: SpatialHeadProjection,
    deltaSeconds: number,
    responseMs: number,
  ): SpatialHeadProjection {
    if (!isFiniteHeadProjection(desired)) {
      this.reset();
      return { ...this.current };
    }

    if (!this.initialized) {
      this.current = { ...desired };
      this.initialized = true;
    } else {
      const factor = responseFactor(deltaSeconds, responseMs);
      this.current = {
        yawDegrees:
          this.current.yawDegrees +
          (desired.yawDegrees - this.current.yawDegrees) * factor,
        pitchDegrees:
          this.current.pitchDegrees +
          (desired.pitchDegrees - this.current.pitchDegrees) * factor,
      };
    }
    return { ...this.current };
  }

  reset(initialProjection: SpatialHeadProjection = {
    yawDegrees: 0,
    pitchDegrees: 0,
  }): void {
    this.current = isFiniteHeadProjection(initialProjection)
      ? { ...initialProjection }
      : { yawDegrees: 0, pitchDegrees: 0 };
    this.initialized = true;
  }
}

function responseFactor(deltaSeconds: number, responseMs: number): number {
  const safeDeltaSeconds = Number.isFinite(deltaSeconds)
    ? Math.max(deltaSeconds, 0)
    : 0;
  const safeResponseMs = Number.isFinite(responseMs)
    ? Math.max(responseMs, 1)
    : 1;
  return 1 - Math.exp(-(safeDeltaSeconds * 1_000) / safeResponseMs);
}

function isFiniteVector(value: Vector3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function isFiniteHeadProjection(value: SpatialHeadProjection): boolean {
  return (
    Number.isFinite(value.yawDegrees) && Number.isFinite(value.pitchDegrees)
  );
}
