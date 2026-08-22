import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import {
  applyMotionPlaybackProfile,
  resolveMotionPlaybackProfile,
} from './motionCorrection.js';
import type { MotionAssetDescriptor } from './motionTypes.js';

const MAX_DELTA_SECONDS = 0.1;
export const MOTION_ENTER_BLEND_DURATION_MS = 180;
export const MOTION_EXIT_BLEND_DURATION_MS = 400;

const DEFAULT_MOTION_BLEND_TIMING = {
  enterMs: MOTION_ENTER_BLEND_DURATION_MS,
  exitMs: MOTION_EXIT_BLEND_DURATION_MS,
} as const;

export type MotionPlaybackState =
  | 'idle'
  | 'entering'
  | 'playing'
  | 'exiting'
  | 'settled';

interface MotionBlendTiming {
  enterMs: number;
  exitMs: number;
}

interface ActiveMotion {
  action: AnimationAction;
  asset: MotionAssetDescriptor;
  clip: AnimationClip;
  state: Exclude<MotionPlaybackState, 'idle'>;
  enterElapsedMs: number;
  exitElapsedMs: number;
  exitStartWeight: number;
  enterBlendMs: number;
  exitBlendMs: number;
}

interface PreparedMotion {
  asset: MotionAssetDescriptor;
  clip: AnimationClip;
  enterBlendMs: number;
  exitBlendMs: number;
}

export class MotionPlayer {
  private readonly mixer: AnimationMixer;
  private activeMotion: ActiveMotion | null = null;
  private preparedMotion: PreparedMotion | null = null;
  private requestGeneration = 0;

  constructor(private readonly root: Object3D) {
    this.mixer = new AnimationMixer(root);
  }

  async play(
    asset: MotionAssetDescriptor,
    vrm: VRM,
    signal?: AbortSignal,
    blendTiming: MotionBlendTiming = DEFAULT_MOTION_BLEND_TIMING,
  ): Promise<void> {
    const prepared = await this.prepare(asset, vrm, signal, blendTiming);
    if (prepared) this.startPrepared();
  }

  async prepare(
    asset: MotionAssetDescriptor,
    vrm: VRM,
    signal?: AbortSignal,
    blendTiming: MotionBlendTiming = DEFAULT_MOTION_BLEND_TIMING,
  ): Promise<boolean> {
    const generation = ++this.requestGeneration;
    this.stopActiveMotion();
    this.preparedMotion = null;
    if (signal?.aborted) return false;

    const assetUrl = new URL(asset.url, document.baseURI);
    if (assetUrl.origin !== window.location.origin) {
      throw new Error('Motion assets must use the Vayria origin.');
    }

    const response = await fetch(assetUrl, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Motion asset request failed with status ${response.status}.`,
      );
    }

    const gltf = await parseGltf(
      await response.arrayBuffer(),
      new URL('.', assetUrl).href,
    );
    if (generation !== this.requestGeneration || signal?.aborted) return false;

    const animations = gltf.userData.vrmAnimations as unknown;
    if (!Array.isArray(animations) || animations.length === 0) {
      throw new Error('The VRMA file does not contain a VRM animation.');
    }

    const clip = applyMotionPlaybackProfile(
      createVRMAnimationClip(animations[0], vrm),
      vrm,
      resolveMotionPlaybackProfile(asset.correctionProfileId),
    );
    if (
      clip.tracks.length === 0 ||
      !Number.isFinite(clip.duration) ||
      !clip.validate()
    ) {
      throw new Error('The VRMA animation contains no valid tracks.');
    }

    if (generation !== this.requestGeneration || signal?.aborted) return false;

    this.preparedMotion = {
      asset,
      clip,
      enterBlendMs: normalizeBlendDuration(blendTiming.enterMs),
      exitBlendMs: normalizeBlendDuration(blendTiming.exitMs),
    };
    return true;
  }

  startPrepared(): boolean {
    const prepared = this.preparedMotion;
    if (!prepared) return false;

    this.stopActiveMotion();
    const { asset, clip, enterBlendMs, exitBlendMs } = prepared;
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(
      asset.loop ? LoopRepeat : LoopOnce,
      asset.loop ? Infinity : 1,
    );
    action.clampWhenFinished = !asset.loop;
    action.setEffectiveWeight(enterBlendMs === 0 ? 1 : 0);
    action.play();
    this.activeMotion = {
      action,
      asset,
      clip,
      state: enterBlendMs === 0 ? 'playing' : 'entering',
      enterElapsedMs: 0,
      exitElapsedMs: 0,
      exitStartWeight: 1,
      enterBlendMs,
      exitBlendMs,
    };
    this.preparedMotion = null;
    return true;
  }

  update(deltaSeconds: number): void {
    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      MAX_DELTA_SECONDS,
    );
    const activeBeforeUpdate = this.activeMotion;
    if (activeBeforeUpdate?.state === 'entering') {
      activeBeforeUpdate.enterElapsedMs = Math.min(
        activeBeforeUpdate.enterBlendMs,
        activeBeforeUpdate.enterElapsedMs + safeDelta * 1_000,
      );
      activeBeforeUpdate.action.setEffectiveWeight(
        getMotionEnterWeight(
          activeBeforeUpdate.enterElapsedMs,
          activeBeforeUpdate.enterBlendMs,
        ),
      );
    }
    if (activeBeforeUpdate?.state === 'exiting') {
      activeBeforeUpdate.exitElapsedMs = Math.min(
        activeBeforeUpdate.exitBlendMs,
        activeBeforeUpdate.exitElapsedMs + safeDelta * 1_000,
      );
      activeBeforeUpdate.action.setEffectiveWeight(
        activeBeforeUpdate.exitStartWeight *
          getMotionExitWeight(
            activeBeforeUpdate.exitElapsedMs,
            activeBeforeUpdate.exitBlendMs,
          ),
      );
    }
    this.mixer.update(safeDelta);

    const activeMotion = this.activeMotion;
    if (!activeMotion) return;

    if (
      activeMotion.state === 'entering' &&
      activeMotion.enterElapsedMs >= activeMotion.enterBlendMs
    ) {
      activeMotion.action.setEffectiveWeight(1);
      activeMotion.state = 'playing';
    }

    if (
      (activeMotion.state === 'entering' ||
        activeMotion.state === 'playing') &&
      !activeMotion.action.isRunning()
    ) {
      if (activeMotion.action.paused && activeMotion.action.clampWhenFinished) {
        // Keep the final VRMA pose until the playback coordinator releases it.
        // A short VRMA must not return to Idle before the speech has ended.
        if (
          activeMotion.state !== 'entering' ||
          activeMotion.enterElapsedMs >= activeMotion.enterBlendMs
        ) {
          activeMotion.action.setEffectiveWeight(1);
          activeMotion.state = 'playing';
        }
      } else {
        this.stopActiveMotion();
        return;
      }
    }

    if (
      activeMotion.state === 'exiting' &&
      activeMotion.exitElapsedMs >= activeMotion.exitBlendMs
    ) {
      activeMotion.action.setEffectiveWeight(0);
      activeMotion.state = 'settled';
    }
  }

  isPlaying(): boolean {
    return this.activeMotion?.state === 'playing';
  }

  get playbackState(): MotionPlaybackState {
    return this.activeMotion?.state ?? 'idle';
  }

  isActive(): boolean {
    return this.activeMotion !== null;
  }

  get activeAssetId(): string | null {
    return this.activeMotion?.asset.assetId ?? null;
  }

  requestExit(): boolean {
    const activeMotion = this.activeMotion;
    if (!activeMotion || activeMotion.state === 'settled') return false;
    if (activeMotion.state === 'exiting') return true;
    this.beginExit(activeMotion);
    return true;
  }

  stop(): void {
    this.requestGeneration += 1;
    this.preparedMotion = null;
    this.stopActiveMotion();
  }

  dispose(): void {
    this.stop();
  }

  private beginExit(activeMotion: ActiveMotion): void {
    activeMotion.exitStartWeight =
      activeMotion.state === 'entering'
        ? getMotionEnterWeight(
            activeMotion.enterElapsedMs,
            activeMotion.enterBlendMs,
          )
        : activeMotion.action.getEffectiveWeight();
    activeMotion.action.paused = true;
    activeMotion.state = 'exiting';
    activeMotion.exitElapsedMs = 0;
  }

  private stopActiveMotion(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.activeMotion = null;
  }
}

export function getMotionEnterWeight(
  elapsedMs: number,
  durationMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  if (elapsedMs >= durationMs) return 1;
  return elapsedMs / durationMs;
}

export function getMotionExitWeight(
  elapsedMs: number,
  durationMs = MOTION_EXIT_BLEND_DURATION_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 0;
  return 1 - elapsedMs / durationMs;
}

function normalizeBlendDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function parseGltf(
  data: ArrayBuffer,
  resourcePath: string,
): Promise<GLTF> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return new Promise((resolve, reject) => {
    loader.parse(data, resourcePath, resolve, reject);
  });
}
