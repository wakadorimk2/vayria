import {
  Euler,
  MathUtils,
  Quaternion,
  type Object3D,
} from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

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
  private readonly offsetEuler = new Euler(0, 0, 0, 'XYZ');
  private readonly offsetRotation = new Quaternion();
  private enabled = true;
  private elapsedSeconds = 0;

  constructor(vrm: VRM) {
    this.captureBone(vrm, VRMHumanBoneName.Hips);
    this.captureBone(vrm, VRMHumanBoneName.Spine);
    this.captureBone(vrm, VRMHumanBoneName.Chest);
    this.captureBone(vrm, VRMHumanBoneName.Head);
  }

  update(deltaSeconds: number, weight = 1, headYawBias = 0): void {
    if (!this.enabled) return;

    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      IDLE_MOTION.maxDeltaSeconds,
    );
    const safeWeight = Math.min(Math.max(weight, 0), 1);
    this.elapsedSeconds += safeDelta;

    const breathing = Math.sin(
      (this.elapsedSeconds * Math.PI * 2) /
        IDLE_MOTION.breathingPeriodSeconds,
    );
    const sway = Math.sin(
      (this.elapsedSeconds * Math.PI * 2) / IDLE_MOTION.swayPeriodSeconds,
    );
    const headYaw = Math.sin(
      (this.elapsedSeconds * Math.PI * 2) /
        IDLE_MOTION.headYawPeriodSeconds,
    );
    const headRoll = Math.sin(
      (this.elapsedSeconds * Math.PI * 2) /
        IDLE_MOTION.headRollPeriodSeconds +
        Math.PI * 0.37,
    );

    this.setOffset(
      VRMHumanBoneName.Hips,
      0,
      0,
      sway * IDLE_MOTION.hipsSwayDegrees * safeWeight,
    );
    this.setOffset(
      VRMHumanBoneName.Spine,
      0,
      0,
      -sway * IDLE_MOTION.spineSwayDegrees * safeWeight,
    );
    this.setOffset(
      VRMHumanBoneName.Chest,
      breathing * IDLE_MOTION.breathingPitchDegrees * safeWeight,
      0,
      0,
    );
    this.setOffset(
      VRMHumanBoneName.Head,
      0,
      headYaw * IDLE_MOTION.headYawDegrees * safeWeight + headYawBias,
      headRoll * IDLE_MOTION.headRollDegrees * safeWeight,
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.restoreCapturedRotations();
  }

  dispose(): void {
    this.restoreCapturedRotations();
    this.bones.clear();
  }

  private restoreCapturedRotations(): void {
    for (const bone of this.bones.values()) {
      bone.node.quaternion.copy(bone.baseRotation);
    }
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
}
