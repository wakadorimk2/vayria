import {
  Euler,
  MathUtils,
  Quaternion,
  type Object3D,
} from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VIEWER_NECK_ATTENTION } from './attentionTarget';

const BASE_POSE_DEGREES = {
  hipsTilt: 1.8,
  spineCounterTilt: 0.8,
  leftShoulderDrop: 6,
  rightShoulderDrop: 2,
  leftUpperArmDrop: 64,
  rightUpperArmDrop: 72,
  leftElbowBend: 12,
  rightElbowBend: 6,
  relaxedKnee: 4,
  neckPitch: 2,
  headYaw: -1.5,
  headTilt: 2,
} as const;

const IDLE_MOTION = {
  maxDeltaSeconds: 0.1,
  breathingPeriodSeconds: 4.8,
  breathingPitchDegrees: 0.35,
  swayPeriodSeconds: 7.3,
  hipsSwayDegrees: 0.25,
  spineSwayDegrees: 0.4,
  headYawPeriodSeconds: 9.7,
  headYawDegrees: 0.6,
  headRollPeriodSeconds: 12.7,
  headRollDegrees: 0.35,
  performanceOverlayWeight: 0.2,
} as const;

type Rotation = readonly [x: number, y: number, z: number];

interface IdleBone {
  node: Object3D;
  baseRotation: Quaternion;
}

function applyRotation(
  vrm: VRM,
  boneName: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName],
  degrees: Rotation,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!node) return;

  const offset = new Quaternion().setFromEuler(
    new Euler(
      MathUtils.degToRad(degrees[0]),
      MathUtils.degToRad(degrees[1]),
      MathUtils.degToRad(degrees[2]),
      'XYZ',
    ),
  );
  node.quaternion.multiply(offset);
}

export function applyBasePose(vrm: VRM): void {
  applyRotation(vrm, VRMHumanBoneName.Hips, [
    0,
    0,
    BASE_POSE_DEGREES.hipsTilt,
  ]);
  applyRotation(vrm, VRMHumanBoneName.Spine, [
    0,
    0,
    -BASE_POSE_DEGREES.spineCounterTilt,
  ]);
  applyRotation(vrm, VRMHumanBoneName.LeftUpperLeg, [
    0,
    0,
    -BASE_POSE_DEGREES.hipsTilt,
  ]);
  applyRotation(vrm, VRMHumanBoneName.RightUpperLeg, [
    0,
    0,
    -BASE_POSE_DEGREES.hipsTilt,
  ]);
  applyRotation(vrm, VRMHumanBoneName.RightLowerLeg, [
    BASE_POSE_DEGREES.relaxedKnee,
    0,
    0,
  ]);
  applyRotation(vrm, VRMHumanBoneName.LeftShoulder, [
    0,
    0,
    -BASE_POSE_DEGREES.leftShoulderDrop,
  ]);
  applyRotation(vrm, VRMHumanBoneName.RightShoulder, [
    0,
    0,
    BASE_POSE_DEGREES.rightShoulderDrop,
  ]);
  applyRotation(vrm, VRMHumanBoneName.LeftUpperArm, [
    0,
    0,
    -BASE_POSE_DEGREES.leftUpperArmDrop,
  ]);
  applyRotation(vrm, VRMHumanBoneName.RightUpperArm, [
    0,
    0,
    BASE_POSE_DEGREES.rightUpperArmDrop,
  ]);
  applyRotation(vrm, VRMHumanBoneName.LeftLowerArm, [
    0,
    -BASE_POSE_DEGREES.leftElbowBend,
    0,
  ]);
  applyRotation(vrm, VRMHumanBoneName.RightLowerArm, [
    0,
    BASE_POSE_DEGREES.rightElbowBend,
    0,
  ]);
  applyRotation(vrm, VRMHumanBoneName.Neck, [
    BASE_POSE_DEGREES.neckPitch,
    0,
    0,
  ]);
  applyRotation(vrm, VRMHumanBoneName.Head, [
    0,
    BASE_POSE_DEGREES.headYaw,
    BASE_POSE_DEGREES.headTilt,
  ]);
}

export class IdleController {
  private readonly bones = new Map<string, IdleBone>();
  private readonly appliedOverlay = new Map<string, Quaternion>();
  private readonly offsetEuler = new Euler(0, 0, 0, 'XYZ');
  private readonly offsetRotation = new Quaternion();
  private enabled = true;
  private elapsedSeconds = 0;

  constructor(vrm: VRM) {
    this.captureBone(vrm, VRMHumanBoneName.Hips);
    this.captureBone(vrm, VRMHumanBoneName.Spine);
    this.captureBone(vrm, VRMHumanBoneName.Chest);
    this.captureBone(vrm, VRMHumanBoneName.Neck);
    this.captureBone(vrm, VRMHumanBoneName.Head);
  }

  update(
    deltaSeconds: number,
    weight = 1,
    headYawBias = 0,
    headPitchBias = 0,
    neckYawBias = 0,
    neckPitchBias = 0,
  ): void {
    if (!this.enabled) return;

    this.advance(deltaSeconds);
    const safeWeight = Math.min(Math.max(weight, 0), 1);
    this.removeOverlay();
    const offsets = this.getOffsets();

    this.setOffset(
      VRMHumanBoneName.Hips,
      0,
      0,
      offsets.sway * IDLE_MOTION.hipsSwayDegrees * safeWeight,
    );
    this.setOffset(
      VRMHumanBoneName.Spine,
      0,
      0,
      -offsets.sway * IDLE_MOTION.spineSwayDegrees * safeWeight,
    );
    this.setOffset(
      VRMHumanBoneName.Chest,
      offsets.breathing * IDLE_MOTION.breathingPitchDegrees * safeWeight,
      0,
      0,
    );
    this.setOffset(
      VRMHumanBoneName.Head,
      headPitchBias,
      offsets.headYaw * IDLE_MOTION.headYawDegrees * safeWeight + headYawBias,
      offsets.headRoll * IDLE_MOTION.headRollDegrees * safeWeight,
    );
    this.setOffset(
      VRMHumanBoneName.Neck,
      clampDegrees(
        neckPitchBias,
        VIEWER_NECK_ATTENTION.maxVerticalAngleDegrees,
      ),
      clampDegrees(
        neckYawBias,
        VIEWER_NECK_ATTENTION.maxHorizontalAngleDegrees,
      ),
      0,
    );
  }

  updateOverlay(
    deltaSeconds: number,
    weight = 1,
    headYawBias = 0,
    headPitchBias = 0,
    overlayWeight = IDLE_MOTION.performanceOverlayWeight,
    neckYawBias = 0,
    neckPitchBias = 0,
  ): void {
    if (!this.enabled) return;

    this.advance(deltaSeconds);
    this.removeOverlay();
    const safeWeight = Math.min(Math.max(weight, 0), 1);
    const safeOverlayWeight = Math.min(
      Math.max(overlayWeight, 0),
      IDLE_MOTION.performanceOverlayWeight,
    );
    const offsets = this.getOffsets();

    this.multiplyOffset(
      VRMHumanBoneName.Hips,
      0,
      0,
      offsets.sway * IDLE_MOTION.hipsSwayDegrees * safeWeight * safeOverlayWeight,
    );
    this.multiplyOffset(
      VRMHumanBoneName.Spine,
      0,
      0,
      -offsets.sway * IDLE_MOTION.spineSwayDegrees * safeWeight * safeOverlayWeight,
    );
    this.multiplyOffset(
      VRMHumanBoneName.Chest,
      offsets.breathing * IDLE_MOTION.breathingPitchDegrees * safeWeight * safeOverlayWeight,
      0,
      0,
    );
    this.multiplyOffset(
      VRMHumanBoneName.Head,
      headPitchBias,
      offsets.headYaw * IDLE_MOTION.headYawDegrees * safeWeight * safeOverlayWeight +
        headYawBias,
      offsets.headRoll * IDLE_MOTION.headRollDegrees * safeWeight * safeOverlayWeight,
    );
    this.multiplyOffset(
      VRMHumanBoneName.Neck,
      clampDegrees(
        neckPitchBias * safeOverlayWeight,
        VIEWER_NECK_ATTENTION.maxVerticalAngleDegrees,
      ),
      clampDegrees(
        neckYawBias * safeOverlayWeight,
        VIEWER_NECK_ATTENTION.maxHorizontalAngleDegrees,
      ),
      0,
    );
  }

  removeOverlay(): void {
    for (const [boneName, offset] of this.appliedOverlay) {
      const bone = this.bones.get(boneName);
      if (!bone) continue;
      bone.node.quaternion.multiply(offset.clone().invert());
    }
    this.appliedOverlay.clear();
  }

  /** Restores the captured base pose before a new gaze allocation is read. */
  resetForGazeFrame(): void {
    if (!this.enabled) return;
    this.removeOverlay();
    this.restoreCapturedRotations();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.removeOverlay();
    if (!enabled) this.restoreCapturedRotations();
  }

  dispose(): void {
    this.removeOverlay();
    this.restoreCapturedRotations();
    this.bones.clear();
  }

  private restoreCapturedRotations(): void {
    for (const bone of this.bones.values()) {
      bone.node.quaternion.copy(bone.baseRotation);
    }
  }

  private advance(deltaSeconds: number): number {
    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      IDLE_MOTION.maxDeltaSeconds,
    );
    this.elapsedSeconds += safeDelta;
    return safeDelta;
  }

  private getOffsets(): {
    breathing: number;
    sway: number;
    headYaw: number;
    headRoll: number;
  } {
    return {
      breathing: Math.sin(
        (this.elapsedSeconds * Math.PI * 2) /
          IDLE_MOTION.breathingPeriodSeconds,
      ),
      sway: Math.sin(
        (this.elapsedSeconds * Math.PI * 2) / IDLE_MOTION.swayPeriodSeconds,
      ),
      headYaw: Math.sin(
        (this.elapsedSeconds * Math.PI * 2) /
          IDLE_MOTION.headYawPeriodSeconds,
      ),
      headRoll: Math.sin(
        (this.elapsedSeconds * Math.PI * 2) /
          IDLE_MOTION.headRollPeriodSeconds +
          Math.PI * 0.37,
      ),
    };
  }

  private captureBone(
    vrm: VRM,
    boneName: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName],
  ): void {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    this.bones.set(boneName, {
      node,
      baseRotation: node.quaternion.clone(),
    });
  }

  private setOffset(
    boneName: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName],
    xDegrees: number,
    yDegrees: number,
    zDegrees: number,
  ): void {
    const bone = this.bones.get(boneName);
    if (!bone) return;

    this.offsetEuler.set(
      MathUtils.degToRad(xDegrees),
      MathUtils.degToRad(yDegrees),
      MathUtils.degToRad(zDegrees),
    );
    this.offsetRotation.setFromEuler(this.offsetEuler);
    bone.node.quaternion
      .copy(bone.baseRotation)
      .multiply(this.offsetRotation);
  }

  private multiplyOffset(
    boneName: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName],
    xDegrees: number,
    yDegrees: number,
    zDegrees: number,
  ): void {
    const bone = this.bones.get(boneName);
    if (!bone) return;

    this.offsetEuler.set(
      MathUtils.degToRad(xDegrees),
      MathUtils.degToRad(yDegrees),
      MathUtils.degToRad(zDegrees),
    );
    this.offsetRotation.setFromEuler(this.offsetEuler);
    bone.node.quaternion.multiply(this.offsetRotation);
    this.appliedOverlay.set(boneName, this.offsetRotation.clone());
  }
}

function clampDegrees(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(value, limit));
}
