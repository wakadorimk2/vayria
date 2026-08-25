import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Object3D, Quaternion } from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import {
  LifeDynamics,
  type LifeDynamicsInputs,
  type LifeDynamicsSnapshot,
} from '../src/avatar/lifeDynamics.js';
import { LifeDynamicsLifeAdapter } from '../src/avatar/lifeDynamicsLifeAdapter.js';

const neutralInputs: LifeDynamicsInputs = {
  arousal: 0,
  curiosity: 0,
  attention: {},
  attentionTarget: null,
  speechUrge: 0,
  inhibition: 0,
  energy: 0.6,
  emotion: 'neutral',
  intent: null,
  gestureIntent: null,
  gestureTrigger: false,
};

function createFakeVrm(): {
  chest: Object3D;
  head: Object3D;
  hips: Object3D;
  spine: Object3D;
  vrm: VRM;
} {
  const nodes = new Map<string, Object3D>();
  const hips = createBone(new Euler(0.02, -0.03, 0.04));
  const spine = createBone(new Euler(-0.04, 0.05, -0.06));
  const chest = createBone(new Euler(0.07, -0.08, 0.09));
  const head = createBone(new Euler(-0.1, 0.11, -0.12));
  nodes.set(VRMHumanBoneName.Hips, hips);
  nodes.set(VRMHumanBoneName.Spine, spine);
  nodes.set(VRMHumanBoneName.Chest, chest);
  nodes.set(VRMHumanBoneName.Head, head);

  return {
    chest,
    head,
    hips,
    spine,
    vrm: {
      humanoid: {
        getNormalizedBoneNode(boneName: string) {
          return nodes.get(boneName) ?? null;
        },
      },
    } as unknown as VRM,
  };
}

function createBone(rotation: Euler): Object3D {
  const bone = new Object3D();
  bone.quaternion.setFromEuler(rotation);
  return bone;
}

function createSnapshot(energy: number): LifeDynamicsSnapshot {
  const core = new LifeDynamics();
  return core.update(
    0.6,
    {
      ...neutralInputs,
      energy,
    },
    () => 0.5,
  );
}

function angleFromBase(base: Quaternion, value: Quaternion): number {
  return base.angleTo(value);
}

test('life adapter changes only spine and chest and keeps a baseline at zero energy', () => {
  const { chest, head, hips, spine, vrm } = createFakeVrm();
  const baseChest = chest.quaternion.clone();
  const baseHead = head.quaternion.clone();
  const baseHips = hips.quaternion.clone();
  const baseSpine = spine.quaternion.clone();
  const adapter = new LifeDynamicsLifeAdapter(vrm);

  adapter.apply(createSnapshot(0));
  const lowEnergyChest = chest.quaternion.clone();
  const lowEnergySpine = spine.quaternion.clone();

  assert.ok(angleFromBase(baseChest, lowEnergyChest) > 0);
  assert.ok(angleFromBase(baseSpine, lowEnergySpine) > 0);
  assert.ok(!chest.quaternion.equals(baseChest));
  assert.ok(head.quaternion.equals(baseHead));
  assert.ok(hips.quaternion.equals(baseHips));

  adapter.reset();
  adapter.apply(createSnapshot(1));
  const highEnergyChest = chest.quaternion.clone();
  const highEnergySpine = spine.quaternion.clone();

  assert.ok(
    angleFromBase(baseChest, highEnergyChest) >
      angleFromBase(baseChest, lowEnergyChest),
  );
  assert.ok(
    angleFromBase(baseSpine, highEnergySpine) >
      angleFromBase(baseSpine, lowEnergySpine),
  );
  assert.ok(head.quaternion.equals(baseHead));
  assert.ok(hips.quaternion.equals(baseHips));
});

test('life adapter applies bounded channels without accumulating rotation', () => {
  const { chest, head, hips, spine, vrm } = createFakeVrm();
  const baseChest = chest.quaternion.clone();
  const baseHead = head.quaternion.clone();
  const baseHips = hips.quaternion.clone();
  const baseSpine = spine.quaternion.clone();
  const adapter = new LifeDynamicsLifeAdapter(vrm);
  const snapshot = createSnapshot(1);
  const variedSnapshot = {
    ...snapshot,
    life: {
      ...snapshot.life,
      posturalDrift: 1,
      asymmetry: -1,
      breathModulation: 1,
    },
  } as LifeDynamicsSnapshot;

  adapter.apply(variedSnapshot);
  const firstChest = chest.quaternion.clone();
  const firstSpine = spine.quaternion.clone();
  adapter.apply(variedSnapshot);

  assert.ok(chest.quaternion.equals(firstChest));
  assert.ok(spine.quaternion.equals(firstSpine));
  assert.ok(!chest.quaternion.equals(baseChest));
  assert.ok(!spine.quaternion.equals(baseSpine));
  assert.ok(head.quaternion.equals(baseHead));
  assert.ok(hips.quaternion.equals(baseHips));

  adapter.reset();

  assert.ok(chest.quaternion.equals(baseChest));
  assert.ok(spine.quaternion.equals(baseSpine));
  adapter.dispose();
});
