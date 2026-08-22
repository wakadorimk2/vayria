import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import type { MotionAssetDescriptor } from './motionTypes.js';

const MAX_DELTA_SECONDS = 0.1;
export const MOTION_EXIT_BLEND_DURATION_MS = 300;

export type MotionPlaybackState =
  | 'idle'
  | 'playing'
  | 'exiting'
  | 'settled';

interface ActiveMotion {
  action: AnimationAction;
  asset: MotionAssetDescriptor;
  clip: AnimationClip;
  state: Exclude<MotionPlaybackState, 'idle'>;
  exitElapsedMs: number;
}

export class MotionPlayer {
  private readonly mixer: AnimationMixer;
  private activeMotion: ActiveMotion | null = null;
  private requestGeneration = 0;

  constructor(private readonly root: Object3D) {
    this.mixer = new AnimationMixer(root);
  }

  async play(
    asset: MotionAssetDescriptor,
    vrm: VRM,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = ++this.requestGeneration;
    this.stopActiveMotion();
    if (signal?.aborted) return;

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
    if (generation !== this.requestGeneration || signal?.aborted) return;

    const animations = gltf.userData.vrmAnimations as unknown;
    if (!Array.isArray(animations) || animations.length === 0) {
      throw new Error('The VRMA file does not contain a VRM animation.');
    }

    const clip = createVRMAnimationClip(animations[0], vrm);
    if (clip.tracks.length === 0 || !Number.isFinite(clip.duration) || !clip.validate()) {
      throw new Error('The VRMA animation contains no valid tracks.');
    }

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(asset.loop ? LoopRepeat : LoopOnce, asset.loop ? Infinity : 1);
    action.clampWhenFinished = !asset.loop;
    action.setEffectiveWeight(1);
    action.play();
    this.activeMotion = {
      action,
      asset,
      clip,
      state: 'playing',
      exitElapsedMs: 0,
    };
  }

  update(deltaSeconds: number): void {
    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      MAX_DELTA_SECONDS,
    );
    const activeBeforeUpdate = this.activeMotion;
    if (activeBeforeUpdate?.state === 'exiting') {
      activeBeforeUpdate.exitElapsedMs = Math.min(
        MOTION_EXIT_BLEND_DURATION_MS,
        activeBeforeUpdate.exitElapsedMs + safeDelta * 1_000,
      );
      activeBeforeUpdate.action.setEffectiveWeight(
        getMotionExitWeight(activeBeforeUpdate.exitElapsedMs),
      );
    }
    this.mixer.update(safeDelta);

    const activeMotion = this.activeMotion;
    if (!activeMotion) return;

    if (activeMotion.state === 'playing' && !activeMotion.action.isRunning()) {
      if (activeMotion.action.paused && activeMotion.action.clampWhenFinished) {
        activeMotion.state = 'exiting';
        activeMotion.exitElapsedMs = 0;
      } else {
        this.stopActiveMotion();
        return;
      }
    }

    if (
      activeMotion.state === 'exiting' &&
      activeMotion.exitElapsedMs >= MOTION_EXIT_BLEND_DURATION_MS
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

  get activeAssetId(): string | null {
    return this.activeMotion?.asset.assetId ?? null;
  }

  stop(): void {
    this.requestGeneration += 1;
    this.stopActiveMotion();
  }

  dispose(): void {
    this.stop();
  }

  private stopActiveMotion(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.activeMotion = null;
  }
}

export function getMotionExitWeight(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1;
  if (elapsedMs >= MOTION_EXIT_BLEND_DURATION_MS) return 0;
  return 1 - elapsedMs / MOTION_EXIT_BLEND_DURATION_MS;
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
