import {
  Euler,
  MathUtils,
  Quaternion,
  type Object3D,
} from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import type { LifeDynamicsSnapshot } from './lifeDynamics.js';

const LIFE_ADAPTER = {
  minimumEnergyAmplitude: 0.4,
  energyAmplitudeRange: 0.6,
  spineSwayDegrees: 0.4,
  chestBreathingDegrees: 0.35,
  chestAsymmetryDegrees: 0.1,
  posturalDriftContribution: 0.25,
  breathModulationRange: 0.12,
} as const;

interface LifeBone {
  node: Object3D;
  baseRotation: Quaternion;
}

/**
 * Projects the LifeDynamics life snapshot onto the VRM torso.
 *
 * The adapter owns no clock or temporal state. Each frame is calculated from
 * the captured post-base-pose rotations.
 */
export class LifeDynamicsLifeAdapter {
  private readonly bones = new Map<string, LifeBone>();
  private readonly offsetEuler = new Euler(0, 0, 0, 'XYZ');
  private readonly offsetRotation = new Quaternion();

  constructor(vrm: VRM) {
    this.captureBone(vrm, VRMHumanBoneName.Spine);
    this.captureBone(vrm, VRMHumanBoneName.Chest);
  }

  apply(snapshot: LifeDynamicsSnapshot): void {
    const energyAmplitude =
      LIFE_ADAPTER.minimumEnergyAmplitude +
      LIFE_ADAPTER.energyAmplitudeRange * clamp(snapshot.modulation.energy);
    const breathing =
      Math.sin(finiteOrZero(snapshot.life.breathingPhase)) *
      (1 +
        LIFE_ADAPTER.breathModulationRange *
          clamp(snapshot.life.breathModulation, -1, 1));
    const sway =
      Math.sin(finiteOrZero(snapshot.life.swayPhase)) +
      LIFE_ADAPTER.posturalDriftContribution *
        clamp(snapshot.life.posturalDrift, -1, 1);
    const asymmetry = clamp(snapshot.life.asymmetry, -1, 1);

    this.setOffset(
      VRMHumanBoneName.Spine,
      0,
      0,
      -sway * LIFE_ADAPTER.spineSwayDegrees * energyAmplitude,
    );
    this.setOffset(
      VRMHumanBoneName.Chest,
      breathing * LIFE_ADAPTER.chestBreathingDegrees * energyAmplitude,
      0,
      asymmetry * LIFE_ADAPTER.chestAsymmetryDegrees * energyAmplitude,
    );
  }

  reset(): void {
    for (const bone of this.bones.values()) {
      bone.node.quaternion.copy(bone.baseRotation);
    }
  }

  dispose(): void {
    this.reset();
    this.bones.clear();
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
    bone.node.quaternion.copy(bone.baseRotation).multiply(this.offsetRotation);
  }
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(value, maximum));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
