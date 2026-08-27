import {
  PerspectiveCamera,
  Plane,
  Ray,
  Vector3,
} from 'three';
import type {
  SpatialTargetSnapshot,
  SpatialTargetRect,
} from '../attention/spatialTargetRegistry.js';
import {
  VIEWER_GAZE_PROJECTION,
} from './attentionTarget.js';
import {
  allocateGaze,
  type GazeAllocationBasis,
  type GazeAllocationProfile,
  type GazeAllocationResult,
  type GazeHandoffState,
} from './gazeAllocation.js';

export interface SpatialTargetBridgeInput {
  readonly camera: PerspectiveCamera;
  readonly eyePosition: Vector3;
  readonly neutralTarget: Vector3;
  readonly snapshot: SpatialTargetSnapshot;
  readonly stageRect: SpatialTargetRect;
  /** Avatar-facing basis used by gaze allocation. This is not the camera ray basis. */
  readonly allocationBasis: GazeAllocationBasis;
  readonly headBasis?: GazeAllocationBasis;
  readonly handoffState?: GazeHandoffState;
  /** Debug-only allocation target override. The resolved target is unchanged. */
  readonly fixedTarget?: Vector3;
  readonly profile?: GazeAllocationProfile;
}

export interface SpatialTargetBridgeResult {
  /** The resolved world target before the eye envelope is applied. */
  readonly target: Vector3;
  readonly rawTarget: Vector3;
  readonly eyeTarget: Vector3;
  readonly headProjection: GazeAllocationResult['headProjection'];
  readonly neckProjection: GazeAllocationResult['neckProjection'];
  readonly rawTargetAngle: GazeAllocationResult['rawTargetAngle'];
  readonly headRelativeAngle: GazeAllocationResult['headRelativeAngle'];
  readonly rawEyeAngle: GazeAllocationResult['rawEyeAngle'];
  readonly eyeAngle: GazeAllocationResult['eyeAngle'];
  readonly residualAngle: GazeAllocationResult['residualAngle'];
  readonly headContribution: GazeAllocationResult['headContribution'];
  readonly neckContribution: GazeAllocationResult['neckContribution'];
  readonly targetEyeVector: GazeAllocationResult['targetEyeVector'];
  readonly normalizedDirection: GazeAllocationResult['normalizedDirection'];
  readonly headRelativeDirection: GazeAllocationResult['headRelativeDirection'];
  readonly eyeRadius: number;
  readonly handoffState: GazeHandoffState;
}

/** Fallback distance used when the LookAt origin has no neutral depth. */
export const SPATIAL_TARGET_REFERENCE_DEPTH = 1;

/**
 * Converts a cached viewport anchor into the world-space target used by VRM.
 *
 * The target lies on a plane normal to the render camera forward vector.
 * The plane uses the neutral target depth when available. Otherwise it uses
 * a stable forward reference depth from the avatar eye origin.
 */
export class SpatialTargetBridge {
  private readonly ndcPoint = new Vector3();
  private readonly rayDirection = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraRight = new Vector3();
  private readonly cameraUp = new Vector3();
  private readonly safeDirection = new Vector3();
  private readonly allocationForward = new Vector3();
  private readonly eyeDepthPoint = new Vector3();
  private readonly worldTarget = new Vector3();
  private readonly ray = new Ray();
  private readonly eyeDepthPlane = new Plane();

  resolve(input: SpatialTargetBridgeInput): SpatialTargetBridgeResult | null {
    if (!isValidRect(input.stageRect)) return null;
    if (!isFiniteVector(input.eyePosition)) return null;
    if (!isFiniteVector(input.neutralTarget)) return null;
    if (!isFiniteVector(input.camera.position)) return null;
    if (
      !isFiniteVector(input.allocationBasis.forward) ||
      !isFiniteVector(input.allocationBasis.right) ||
      !isFiniteVector(input.allocationBasis.up)
    ) {
      return null;
    }
    if (
      !Number.isFinite(input.snapshot.point.x) ||
      !Number.isFinite(input.snapshot.point.y)
    ) {
      return null;
    }

    const normalizedX =
      (input.snapshot.point.x - input.stageRect.left) / input.stageRect.width;
    const normalizedY =
      (input.snapshot.point.y - input.stageRect.top) / input.stageRect.height;
    if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) {
      return null;
    }

    input.camera.updateMatrixWorld(true);
    input.camera.getWorldDirection(this.cameraForward).normalize();
    this.cameraRight
      .setFromMatrixColumn(input.camera.matrixWorld, 0)
      .normalize();
    this.cameraUp.setFromMatrixColumn(input.camera.matrixWorld, 1).normalize();
    if (
      !isFiniteVector(this.cameraForward) ||
      !isFiniteVector(this.cameraRight) ||
      !isFiniteVector(this.cameraUp)
    ) {
      return null;
    }

    const ndcX = normalizedX * 2 - 1;
    const ndcY = 1 - normalizedY * 2;
    this.ndcPoint.set(ndcX, ndcY, 0.5).unproject(input.camera);
    this.rayDirection
      .copy(this.ndcPoint)
      .sub(input.camera.position)
      .normalize();
    if (!isFiniteVector(this.rayDirection)) return null;

    const rawYaw = Math.atan2(
      this.rayDirection.dot(this.cameraRight),
      this.rayDirection.dot(this.cameraForward),
    );
    const rawPitch = Math.atan2(
      this.rayDirection.dot(this.cameraUp),
      this.rayDirection.dot(this.cameraForward),
    );
    const yaw = clampRadians(
      rawYaw,
      VIEWER_GAZE_PROJECTION.maxHorizontalAngleDegrees,
    );
    const pitch = clampRadians(
      rawPitch,
      VIEWER_GAZE_PROJECTION.maxVerticalAngleDegrees,
    );
    this.safeDirection
      .copy(this.cameraForward)
      .addScaledVector(this.cameraRight, Math.tan(yaw))
      .addScaledVector(this.cameraUp, Math.tan(pitch))
      .normalize();
    if (!isFiniteVector(this.safeDirection)) return null;

    this.ray.origin.copy(input.camera.position);
    this.ray.direction.copy(this.safeDirection);
    this.allocationForward.copy(input.allocationBasis.forward).normalize();
    if (!isFiniteVector(this.allocationForward)) return null;
    const neutralDepth = input.neutralTarget.distanceTo(input.eyePosition);
    const referenceDepth =
      Number.isFinite(neutralDepth) && neutralDepth > 0.000001
        ? neutralDepth
        : SPATIAL_TARGET_REFERENCE_DEPTH;
    this.eyeDepthPoint
      .copy(input.eyePosition)
      .addScaledVector(this.allocationForward, referenceDepth);
    this.eyeDepthPlane.setFromNormalAndCoplanarPoint(
      this.cameraForward,
      this.eyeDepthPoint,
    );
    if (!this.ray.intersectPlane(this.eyeDepthPlane, this.worldTarget)) {
      return null;
    }
    if (!isFiniteVector(this.worldTarget)) return null;

    const allocationTarget = input.fixedTarget ?? this.worldTarget;
    if (!isFiniteVector(allocationTarget)) return null;
    const allocation = allocateGaze({
      eyePosition: input.eyePosition,
      neutralTarget: input.neutralTarget,
      resolvedTarget: allocationTarget,
      neutralBasis: input.allocationBasis,
      headBasis: input.headBasis,
      handoffState: input.handoffState,
      profile: input.profile ?? 'spatial',
    });
    if (!allocation) return null;

    return {
      target: this.worldTarget.clone(),
      rawTarget: allocation.rawTarget,
      eyeTarget: allocation.eyeTarget,
      headProjection: allocation.headProjection,
      neckProjection: allocation.neckProjection,
      rawTargetAngle: allocation.rawTargetAngle,
      headRelativeAngle: allocation.headRelativeAngle,
      rawEyeAngle: allocation.rawEyeAngle,
      eyeAngle: allocation.eyeAngle,
      residualAngle: allocation.residualAngle,
      headContribution: allocation.headContribution,
      neckContribution: allocation.neckContribution,
      targetEyeVector: allocation.targetEyeVector,
      normalizedDirection: allocation.normalizedDirection,
      headRelativeDirection: allocation.headRelativeDirection,
      eyeRadius: allocation.eyeRadius,
      handoffState: allocation.handoffState,
    };
  }
}

function isValidRect(rect: SpatialTargetRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function isFiniteVector(vector: Vector3): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}

function clampRadians(value: number, maxDegrees: number): number {
  if (!Number.isFinite(value)) return 0;
  const limit = (maxDegrees * Math.PI) / 180;
  return Math.max(-limit, Math.min(value, limit));
}
