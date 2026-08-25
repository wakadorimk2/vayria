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
  VIEWER_HEAD_ATTENTION,
  type ViewerHeadBias,
} from './attentionTarget.js';

export interface SpatialTargetBridgeInput {
  readonly camera: PerspectiveCamera;
  readonly eyePosition: Vector3;
  readonly neutralTarget: Vector3;
  readonly snapshot: SpatialTargetSnapshot;
  readonly stageRect: SpatialTargetRect;
}

export interface SpatialTargetBridgeResult {
  readonly target: Vector3;
  readonly headBias: ViewerHeadBias;
}

/**
 * Converts a cached viewport anchor into the world-space target used by VRM.
 *
 * The target lies on a plane through the neutral gaze point. The plane is
 * normal to the render camera forward vector, so the result stays at the
 * avatar's eye depth while the anchor moves across the stage.
 */
export class SpatialTargetBridge {
  private readonly ndcPoint = new Vector3();
  private readonly rayDirection = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly safeDirection = new Vector3();
  private readonly headDirection = new Vector3();
  private readonly worldTarget = new Vector3();
  private readonly ray = new Ray();
  private readonly eyeDepthPlane = new Plane();

  resolve(input: SpatialTargetBridgeInput): SpatialTargetBridgeResult | null {
    if (!isValidRect(input.stageRect)) return null;
    if (!isFiniteVector(input.eyePosition)) return null;
    if (!isFiniteVector(input.neutralTarget)) return null;
    if (!isFiniteVector(input.camera.position)) return null;
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
    input.camera.getWorldDirection(this.forward).normalize();
    this.right
      .setFromMatrixColumn(input.camera.matrixWorld, 0)
      .normalize();
    this.up.setFromMatrixColumn(input.camera.matrixWorld, 1).normalize();
    if (
      !isFiniteVector(this.forward) ||
      !isFiniteVector(this.right) ||
      !isFiniteVector(this.up)
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
      this.rayDirection.dot(this.right),
      this.rayDirection.dot(this.forward),
    );
    const rawPitch = Math.atan2(
      this.rayDirection.dot(this.up),
      this.rayDirection.dot(this.forward),
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
      .copy(this.forward)
      .addScaledVector(this.right, Math.tan(yaw))
      .addScaledVector(this.up, Math.tan(pitch))
      .normalize();
    if (!isFiniteVector(this.safeDirection)) return null;

    this.ray.origin.copy(input.camera.position);
    this.ray.direction.copy(this.safeDirection);
    this.eyeDepthPlane.setFromNormalAndCoplanarPoint(
      this.forward,
      input.neutralTarget,
    );
    if (!this.ray.intersectPlane(this.eyeDepthPlane, this.worldTarget)) {
      return null;
    }
    if (!isFiniteVector(this.worldTarget)) return null;

    this.headDirection.copy(this.worldTarget).sub(input.eyePosition);
    let headBias: ViewerHeadBias = { yawDegrees: 0, pitchDegrees: 0 };
    if (this.headDirection.lengthSq() > 0.000001) {
      const headYaw = Math.atan2(
        this.headDirection.dot(this.right),
        this.headDirection.dot(this.forward),
      );
      const headPitch = Math.atan2(
        this.headDirection.dot(this.up),
        this.headDirection.dot(this.forward),
      );
      headBias = {
        yawDegrees: clampDegrees(
          (headYaw * 180) / Math.PI * VIEWER_HEAD_ATTENTION.followRatio,
          VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
        ),
        pitchDegrees: clampDegrees(
          (headPitch * 180) / Math.PI * VIEWER_HEAD_ATTENTION.followRatio,
          VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
        ),
      };
    }

    return {
      target: this.worldTarget.clone(),
      headBias,
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

function clampDegrees(value: number, maxDegrees: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maxDegrees, Math.min(value, maxDegrees));
}
