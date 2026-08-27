import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import {
  LifeDynamics,
  type LifeDynamicsSnapshot,
} from '../src/avatar/lifeDynamics.js';
import { LifeDynamicsOrientingAdapter } from '../src/avatar/lifeDynamicsOrientingAdapter.js';

interface FakeLookAt {
  resetCount: number;
  target: Object3D | null;
  reset(): void;
  getLookAtWorldPosition(target: Vector3): Vector3;
}

function createFakeVrm(withLookAt = true, withNeck = true): {
  head: Object3D;
  neck: Object3D;
  lookAt: FakeLookAt | undefined;
  vrm: VRM;
} {
  const head = new Object3D();
  const neck = new Object3D();
  const lookAt = withLookAt
    ? {
        resetCount: 0,
        target: null,
        reset() {
          this.resetCount += 1;
        },
        getLookAtWorldPosition(target: Vector3) {
          return target.set(0, 1, 2);
        },
      }
    : undefined;

  return {
    head,
    neck,
    lookAt,
    vrm: {
      humanoid: {
        getNormalizedBoneNode(boneName: VRMHumanBoneName) {
          return boneName === VRMHumanBoneName.Neck
            ? withNeck
              ? neck
              : undefined
            : head;
        },
      },
      lookAt,
    } as unknown as VRM,
  };
}

function createSnapshot(): LifeDynamicsSnapshot {
  const core = new LifeDynamics();
  return core.update(
    0.1,
    {
      arousal: 1,
      curiosity: 0,
      attention: { viewer: 1 },
      attentionTarget: 'viewer',
      speechUrge: 0,
      inhibition: 0,
      energy: 1,
      emotion: 'neutral',
      intent: null,
      gestureIntent: null,
      gestureTrigger: false,
    },
    () => 0.5,
  );
}

test('adapter maps orienting to LookAt and clamps head and neck angles', () => {
  const { head, neck, lookAt, vrm } = createFakeVrm();
  const adapter = new LifeDynamicsOrientingAdapter(vrm);
  const snapshot = createSnapshot();
  const neutralTarget = new Vector3(0, 1, 2);
  const desiredTarget = new Vector3(2, 1, 5);

  adapter.apply({
    snapshot,
    neutralTarget,
    desiredTarget,
    headBias: { yawDegrees: 100, pitchDegrees: -100 },
    neckBias: { yawDegrees: 100, pitchDegrees: -100 },
    vrmaActive: false,
  });

  assert.ok(lookAt?.target);
  assert.ok(lookAt.target.position.x > neutralTarget.x);
  const rotation = new Euler().setFromQuaternion(head.quaternion, 'XYZ');
  assert.ok(Math.abs(rotation.x) <= (6 * Math.PI) / 180 + 0.0001);
  assert.ok(Math.abs(rotation.y) <= (8 * Math.PI) / 180 + 0.0001);
  const neckRotation = new Euler().setFromQuaternion(neck.quaternion, 'XYZ');
  assert.ok(Math.abs(neckRotation.x) <= (3 * Math.PI) / 180 + 0.0001);
  assert.ok(Math.abs(neckRotation.y) <= (4 * Math.PI) / 180 + 0.0001);

  adapter.reset();
  assert.equal(lookAt?.target, null);
  assert.equal(lookAt?.resetCount, 1);
  assert.ok(head.quaternion.equals(new Quaternion()));
  assert.ok(neck.quaternion.equals(new Quaternion()));
});

test('adapter provides a head fallback when LookAt is unavailable', () => {
  const { head, vrm } = createFakeVrm(false);
  const adapter = new LifeDynamicsOrientingAdapter(vrm);

  assert.doesNotThrow(() => {
    adapter.apply({
      snapshot: createSnapshot(),
      neutralTarget: new Vector3(0, 1, 2),
      desiredTarget: new Vector3(2, 1, 5),
      headBias: { yawDegrees: 4, pitchDegrees: 2 },
      neckBias: { yawDegrees: 2, pitchDegrees: 1 },
      vrmaActive: false,
    });
  });
  assert.equal(head.quaternion.equals(new Quaternion()), false);
  assert.doesNotThrow(() => adapter.reset());
});

test('adapter ignores a missing neck bone safely', () => {
  const { vrm } = createFakeVrm(true, false);
  const adapter = new LifeDynamicsOrientingAdapter(vrm);

  assert.doesNotThrow(() => {
    adapter.apply({
      snapshot: createSnapshot(),
      neutralTarget: new Vector3(0, 1, 2),
      desiredTarget: new Vector3(2, 1, 5),
      headBias: { yawDegrees: 4, pitchDegrees: 2 },
      neckBias: { yawDegrees: 4, pitchDegrees: 2 },
      vrmaActive: false,
    });
    adapter.reset();
  });
});

test('adapter produces no output while VRMA is active', () => {
  const { head, neck, lookAt, vrm } = createFakeVrm();
  const adapter = new LifeDynamicsOrientingAdapter(vrm);

  adapter.apply({
    snapshot: createSnapshot(),
    neutralTarget: new Vector3(0, 1, 2),
    desiredTarget: new Vector3(2, 1, 5),
    headBias: { yawDegrees: 4, pitchDegrees: 2 },
    neckBias: { yawDegrees: 2, pitchDegrees: 1 },
    vrmaActive: true,
  });

  assert.equal(lookAt?.target, null);
  assert.ok(head.quaternion.equals(new Quaternion()));
  assert.ok(neck.quaternion.equals(new Quaternion()));
});
