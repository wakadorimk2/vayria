import {
  Euler,
  MathUtils,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import {
  VIEWER_HEAD_ATTENTION,
  VIEWER_NECK_ATTENTION,
  type ViewerHeadBias,
} from './attentionTarget.js';
import type { LifeDynamicsSnapshot } from './lifeDynamics.js';

export interface LifeDynamicsOrientingFrame {
  readonly snapshot: LifeDynamicsSnapshot;
  readonly neutralTarget: Vector3;
  readonly desiredTarget: Vector3 | null;
  readonly headBias: ViewerHeadBias;
  readonly neckBias: ViewerHeadBias;
  readonly vrmaActive: boolean;
}

/**
 * Converts a LifeDynamics snapshot into the existing VRM orienting outputs.
 *
 * The adapter has no clock or transition state. It only removes its previous
 * frame output before applying the next snapshot.
 */
export class LifeDynamicsOrientingAdapter {
  private readonly gazeTarget = new Object3D();
  private readonly offsetEuler = new Euler(0, 0, 0, 'XYZ');
  private readonly offsetRotation = new Quaternion();
  private readonly appliedHeadOffset = new Quaternion();
  private readonly appliedNeckOffset = new Quaternion();
  private readonly headNode: Object3D | null;
  private readonly neckNode: Object3D | null;
  private hasAppliedHeadOffset = false;
  private hasAppliedNeckOffset = false;

  constructor(private readonly vrm: VRM) {
    this.headNode = vrm.humanoid.getNormalizedBoneNode(
      VRMHumanBoneName.Head,
    );
    this.neckNode = vrm.humanoid.getNormalizedBoneNode(
      VRMHumanBoneName.Neck,
    );
  }

  apply(frame: LifeDynamicsOrientingFrame): void {
    this.clearOutput();

    if (
      frame.vrmaActive ||
      frame.snapshot.orienting.target === null ||
      frame.desiredTarget === null
    ) {
      return;
    }

    const eyeWeight = clamp(frame.snapshot.orienting.eyeWeight);
    if (this.vrm.lookAt) {
      this.gazeTarget.position.lerpVectors(
        frame.neutralTarget,
        frame.desiredTarget,
        eyeWeight,
      );
      this.vrm.lookAt.target = this.gazeTarget;
    }

    const headWeight = clamp(frame.snapshot.orienting.headWeight);
    if (headWeight <= 0) return;

    if (this.headNode) {
      const yawDegrees = clampDegrees(
        frame.headBias.yawDegrees * headWeight,
        VIEWER_HEAD_ATTENTION.maxHorizontalAngleDegrees,
      );
      const pitchDegrees = clampDegrees(
        frame.headBias.pitchDegrees * headWeight,
        VIEWER_HEAD_ATTENTION.maxVerticalAngleDegrees,
      );
      this.offsetEuler.set(
        MathUtils.degToRad(pitchDegrees),
        MathUtils.degToRad(yawDegrees),
        0,
      );
      this.offsetRotation.setFromEuler(this.offsetEuler);
      this.headNode.quaternion.multiply(this.offsetRotation);
      this.appliedHeadOffset.copy(this.offsetRotation);
      this.hasAppliedHeadOffset = true;
    }

    if (this.neckNode) {
      const neckYawDegrees = clampDegrees(
        frame.neckBias.yawDegrees * headWeight,
        VIEWER_NECK_ATTENTION.maxHorizontalAngleDegrees,
      );
      const neckPitchDegrees = clampDegrees(
        frame.neckBias.pitchDegrees * headWeight,
        VIEWER_NECK_ATTENTION.maxVerticalAngleDegrees,
      );
      this.offsetEuler.set(
        MathUtils.degToRad(neckPitchDegrees),
        MathUtils.degToRad(neckYawDegrees),
        0,
      );
      this.offsetRotation.setFromEuler(this.offsetEuler);
      this.neckNode.quaternion.multiply(this.offsetRotation);
      this.appliedNeckOffset.copy(this.offsetRotation);
      this.hasAppliedNeckOffset = true;
    }
  }

  reset(): void {
    this.clearOutput();
  }

  dispose(): void {
    this.reset();
  }

  private clearOutput(): void {
    if (this.hasAppliedNeckOffset && this.neckNode) {
      this.neckNode.quaternion.multiply(this.appliedNeckOffset.clone().invert());
    }
    this.hasAppliedNeckOffset = false;

    if (this.hasAppliedHeadOffset && this.headNode) {
      this.headNode.quaternion.multiply(this.appliedHeadOffset.clone().invert());
    }
    this.hasAppliedHeadOffset = false;

    if (this.vrm.lookAt?.target === this.gazeTarget) {
      this.vrm.lookAt.target = null;
      this.vrm.lookAt.reset();
    }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}

function clampDegrees(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(value, limit));
}
