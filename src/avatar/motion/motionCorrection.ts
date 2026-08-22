import { AnimationClip, Quaternion, type KeyframeTrack } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { MotionPlaybackProfile } from './motionTypes.js';

export type { MotionPlaybackProfile } from './motionTypes.js';

export const DEFAULT_MOTION_PLAYBACK_PROFILE: Readonly<MotionPlaybackProfile> =
  Object.freeze({
    profileId: 'vayria-default-v1',
    hipsTranslationScale: 0,
    hipsRotationScale: 0.6,
    spineRotationScale: 0.6,
    chestRotationScale: 0.6,
    upperChestRotationScale: 0.6,
    neckRotationScale: 0.35,
    headRotationScale: 0.35,
    lookAtRotationScale: 0.35,
  });

const MOTION_PLAYBACK_PROFILES: Readonly<
  Record<string, MotionPlaybackProfile>
> = {
  [DEFAULT_MOTION_PLAYBACK_PROFILE.profileId]: DEFAULT_MOTION_PLAYBACK_PROFILE,
};

type MotionBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head';

export function resolveMotionPlaybackProfile(
  profileId: string,
): MotionPlaybackProfile {
  return MOTION_PLAYBACK_PROFILES[profileId] ?? DEFAULT_MOTION_PLAYBACK_PROFILE;
}

export function applyMotionPlaybackProfile(
  clip: AnimationClip,
  vrm: VRM,
  profile: MotionPlaybackProfile,
): AnimationClip {
  const correctedClip = clip.clone();
  const normalizedBoneNames = new Map<MotionBoneName, string>();
  const getNormalizedBoneName = (boneName: MotionBoneName): string | null => {
    if (normalizedBoneNames.has(boneName)) {
      return normalizedBoneNames.get(boneName) ?? null;
    }

    const nodeName = vrm.humanoid?.getNormalizedBoneNode(boneName)?.name;
    if (nodeName) normalizedBoneNames.set(boneName, nodeName);
    return nodeName ?? null;
  };

  const rotationScales = new Map<string, number>();
  const addRotationScale = (
    boneName: MotionBoneName,
    scale: number,
  ): void => {
    const nodeName = getNormalizedBoneName(boneName);
    if (nodeName) rotationScales.set(nodeName, clampScale(scale));
  };

  addRotationScale('hips', profile.hipsRotationScale);
  addRotationScale('spine', profile.spineRotationScale);
  addRotationScale('chest', profile.chestRotationScale);
  addRotationScale('upperChest', profile.upperChestRotationScale);
  addRotationScale('neck', profile.neckRotationScale);
  addRotationScale('head', profile.headRotationScale);

  const hipsNodeName = getNormalizedBoneName('hips');
  const hipsPositionTrackName = hipsNodeName
    ? `${hipsNodeName}.position`
    : null;
  const lookAtRotationMarker = 'VRMLookAtQuaternionProxy.quaternion';

  for (const track of correctedClip.tracks) {
    if (track.name === hipsPositionTrackName) {
      scaleTranslationTrack(track, profile.hipsTranslationScale);
      continue;
    }

    if (track.name.includes(lookAtRotationMarker)) {
      scaleQuaternionTrack(track, profile.lookAtRotationScale);
      continue;
    }

    if (!track.name.endsWith('.quaternion')) continue;
    const nodeName = track.name.slice(0, -'.quaternion'.length);
    const rotationScale = rotationScales.get(nodeName);
    if (rotationScale === undefined) continue;
    scaleQuaternionTrack(track, rotationScale);
  }

  return correctedClip;
}

function scaleTranslationTrack(track: KeyframeTrack, scale: number): void {
  const normalizedScale = clampScale(scale);
  if (track.values.length < 3 || normalizedScale >= 1) return;

  const values = track.values.slice();
  const baseX = values[0] ?? 0;
  const baseY = values[1] ?? 0;
  const baseZ = values[2] ?? 0;
  for (let index = 0; index < values.length; index += 3) {
    values[index] = baseX + ((values[index] ?? baseX) - baseX) * normalizedScale;
    values[index + 1] =
      baseY + ((values[index + 1] ?? baseY) - baseY) * normalizedScale;
    values[index + 2] =
      baseZ + ((values[index + 2] ?? baseZ) - baseZ) * normalizedScale;
  }
  track.values = values;
}

function scaleQuaternionTrack(track: KeyframeTrack, scale: number): void {
  const normalizedScale = clampScale(scale);
  if (track.values.length < 4 || normalizedScale >= 1) return;

  const values = track.values.slice();
  const base = readQuaternion(values, 0);
  const current = new Quaternion();
  const corrected = new Quaternion();
  for (let index = 0; index < values.length; index += 4) {
    current.copy(readQuaternion(values, index));
    corrected.copy(base).slerp(current, normalizedScale);
    corrected.toArray(values, index);
  }
  track.values = values;
}

function readQuaternion(values: Float32Array, offset: number): Quaternion {
  const quaternion = new Quaternion(
    values[offset] ?? 0,
    values[offset + 1] ?? 0,
    values[offset + 2] ?? 0,
    values[offset + 3] ?? 1,
  );
  if (quaternion.lengthSq() === 0) quaternion.identity();
  return quaternion.normalize();
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
