import assert from 'node:assert/strict';
import test from 'node:test';
import type { VRM } from '@pixiv/three-vrm';
import {
  AnimationClip,
  NumberKeyframeTrack,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import {
  applyMotionPlaybackProfile,
  DEFAULT_MOTION_PLAYBACK_PROFILE,
  resolveMotionPlaybackProfile,
} from '../src/avatar/motion/motionCorrection.js';
import {
  getMotionEnterWeight,
  getMotionExitWeight,
  MOTION_ENTER_BLEND_DURATION_MS,
  MOTION_EXIT_BLEND_DURATION_MS,
} from '../src/avatar/motion/motionPlayer.js';

function createFakeVrm(): {
  humanoid: {
    getNormalizedBoneNode: (boneName: string) => Object3D | null;
  };
} {
  const nodes = new Map<string, Object3D>();
  for (const boneName of [
    'hips',
    'spine',
    'chest',
    'upperChest',
    'neck',
    'head',
  ]) {
    const node = new Object3D();
    node.name = `${boneName}-normalized`;
    nodes.set(boneName, node);
  }

  return {
    humanoid: {
      getNormalizedBoneNode: (boneName) => nodes.get(boneName) ?? null,
    },
  };
}

function quaternionValues(quaternion: Quaternion): number[] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function readQuaternion(values: Float32Array, offset: number): Quaternion {
  return new Quaternion(
    values[offset] ?? 0,
    values[offset + 1] ?? 0,
    values[offset + 2] ?? 0,
    values[offset + 3] ?? 1,
  ).normalize();
}

function quaternionAngleDegrees(
  first: Quaternion,
  second: Quaternion,
): number {
  const dot = Math.min(1, Math.abs(first.dot(second)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

function findTrack(clip: AnimationClip, name: string) {
  const track = clip.tracks.find((candidate) => candidate.name === name);
  assert.ok(track, `Missing test track: ${name}`);
  return track;
}

test('VRMA enter weight blends from idle over 180ms', () => {
  assert.equal(MOTION_ENTER_BLEND_DURATION_MS, 180);
  assert.equal(getMotionEnterWeight(-1, 180), 0);
  assert.equal(getMotionEnterWeight(0, 180), 0);
  assert.equal(getMotionEnterWeight(90, 180), 0.5);
  assert.equal(getMotionEnterWeight(180, 180), 1);
  assert.equal(getMotionEnterWeight(360, 180), 1);
  assert.equal(getMotionEnterWeight(90, 0), 1);
});

test('VRMA exit weight blends to idle over 400ms', () => {
  assert.equal(MOTION_EXIT_BLEND_DURATION_MS, 400);
  assert.equal(getMotionExitWeight(-1), 1);
  assert.equal(getMotionExitWeight(0), 1);
  assert.equal(getMotionExitWeight(200), 0.5);
  assert.equal(getMotionExitWeight(400), 0);
  assert.equal(getMotionExitWeight(600), 0);
  assert.equal(getMotionExitWeight(200, 0), 0);
});

test('safe playback correction anchors hips and attenuates head and torso rotation', () => {
  const vrm = createFakeVrm();
  const headTarget = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    Math.PI / 2,
  );
  const neckTarget = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    Math.PI / 3,
  );
  const chestTarget = new Quaternion().setFromAxisAngle(
    new Vector3(0, 0, 1),
    Math.PI / 2,
  );
  const armTarget = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    Math.PI / 2,
  );
  const clip = new AnimationClip('correction-test', 1, [
    new VectorKeyframeTrack(
      'hips-normalized.position',
      [0, 1],
      [1, 2, 3, 1.4, 2.5, 2.5],
    ),
    new QuaternionKeyframeTrack(
      'head-normalized.quaternion',
      [0, 1],
      [0, 0, 0, 1, ...quaternionValues(headTarget)],
    ),
    new QuaternionKeyframeTrack(
      'neck-normalized.quaternion',
      [0, 1],
      [0, 0, 0, 1, ...quaternionValues(neckTarget)],
    ),
    new QuaternionKeyframeTrack(
      'chest-normalized.quaternion',
      [0, 1],
      [0, 0, 0, 1, ...quaternionValues(chestTarget)],
    ),
    new QuaternionKeyframeTrack(
      'arm-normalized.quaternion',
      [0, 1],
      [0, 0, 0, 1, ...quaternionValues(armTarget)],
    ),
    new NumberKeyframeTrack(
      'face.morphTargetInfluences',
      [0, 1],
      [0.1, 0.8],
    ),
    new QuaternionKeyframeTrack(
      'VRMLookAtQuaternionProxy.quaternion',
      [0, 1],
      [0, 0, 0, 1, ...quaternionValues(headTarget)],
    ),
  ]);
  const originalHipsValues = Array.from(
    findTrack(clip, 'hips-normalized.position').values,
  );

  const corrected = applyMotionPlaybackProfile(
    clip,
    vrm as unknown as VRM,
    DEFAULT_MOTION_PLAYBACK_PROFILE,
  );
  const hips = findTrack(corrected, 'hips-normalized.position');
  assert.deepEqual(Array.from(hips.values), [1, 2, 3, 1, 2, 3]);
  assert.deepEqual(
    Array.from(findTrack(clip, 'hips-normalized.position').values),
    originalHipsValues,
  );

  const head = findTrack(corrected, 'head-normalized.quaternion');
  assert.ok(
    Math.abs(
      quaternionAngleDegrees(
        readQuaternion(head.values, 0),
        readQuaternion(head.values, 4),
      ) -
        31.5,
    ) < 0.1,
  );

  const neck = findTrack(corrected, 'neck-normalized.quaternion');
  assert.ok(
    Math.abs(
      quaternionAngleDegrees(
        readQuaternion(neck.values, 0),
        readQuaternion(neck.values, 4),
      ) -
        21,
    ) < 0.1,
  );

  const chest = findTrack(corrected, 'chest-normalized.quaternion');
  assert.ok(
    Math.abs(
      quaternionAngleDegrees(
        readQuaternion(chest.values, 0),
        readQuaternion(chest.values, 4),
      ) -
        54,
    ) < 0.1,
  );

  assert.deepEqual(
    Array.from(findTrack(corrected, 'arm-normalized.quaternion').values),
    Array.from(findTrack(clip, 'arm-normalized.quaternion').values),
  );
  assert.deepEqual(
    Array.from(findTrack(corrected, 'face.morphTargetInfluences').values),
    Array.from(findTrack(clip, 'face.morphTargetInfluences').values),
  );

  const lookAt = findTrack(
    corrected,
    'VRMLookAtQuaternionProxy.quaternion',
  );
  assert.ok(
    Math.abs(
      quaternionAngleDegrees(
        readQuaternion(lookAt.values, 0),
        readQuaternion(lookAt.values, 4),
      ) -
        31.5,
    ) < 0.1,
  );
});

test('unknown playback profiles use the safe default', () => {
  assert.deepEqual(
    resolveMotionPlaybackProfile('unknown-profile'),
    DEFAULT_MOTION_PLAYBACK_PROFILE,
  );
});
