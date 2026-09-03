import type {
  PlayAudio,
  PlayAudioOptions,
} from '../audio/useAudioLipSync.js';
import type { AudioPlaybackSource } from '../audio/audioPlaybackSource.js';
import type { PerformancePlan } from './types.js';

export interface PerformanceMotionPort {
  prepareMotion(
    plan: PerformancePlan,
    signal?: AbortSignal,
  ): Promise<boolean>;
  startPreparedMotion(planId: string): number | null;
  markSpeechStart(planId: string, startedAt: number): void;
  markSpeechEnd(planId: string, endedAt: number): void;
  finishMotion(planId: string): void;
  stopMotion(planId: string): void;
}

export type PerformancePlaybackTimerHandle = ReturnType<typeof setTimeout>;

export interface PerformancePlaybackClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): PerformancePlaybackTimerHandle;
  clearTimeout(handle: PerformancePlaybackTimerHandle): void;
}

export interface PerformancePlaybackCallbacks {
  onAudioComplete?: (completedAt: number) => void;
  onFirstAudioReady?: (readyAt: number) => void;
  onMotionReady?: (readyAt: number) => void;
  onMotionStart?: (startedAt: number) => void;
  onPlaybackGestureRequired?: PlayAudioOptions['onPlaybackGestureRequired'];
  onSpeechStart?: (startedAt: number) => void;
  onSpeechEnd?: (endedAt: number) => void;
  presentationLeadMs?: number;
}

export interface PerformancePlaybackResult {
  motionStartedAt?: number;
  speechStartedAt?: number;
  speechEndedAt: number;
}

export interface PerformancePlayback {
  prepare(plan: PerformancePlan): void;
  play(
    plan: PerformancePlan,
    audioSource: AudioPlaybackSource,
    callbacks?: PerformancePlaybackCallbacks,
  ): Promise<PerformancePlaybackResult | null>;
  stop(): void;
}

interface PerformancePlaybackOptions {
  getMotionPort: () => PerformanceMotionPort | null;
  playAudio: PlayAudio;
  stopAudio: () => void;
  clock?: PerformancePlaybackClock;
  now?: () => number;
}

interface PreparationState {
  controller: AbortController;
  planId: string;
  assetId: string | null;
  promise: Promise<boolean>;
}

class PlaybackCancelledError extends Error {
  constructor() {
    super('Performance playback was cancelled.');
    this.name = 'PlaybackCancelledError';
  }
}

export class PerformancePlaybackCoordinator implements PerformancePlayback {
  private readonly getMotionPort: PerformancePlaybackOptions['getMotionPort'];
  private readonly playAudio: PlayAudio;
  private readonly stopAudio: () => void;
  private readonly clock: PerformancePlaybackClock;
  private generation = 0;
  private activePlanId: string | null = null;
  private preparation: PreparationState | null = null;
  private playbackController: AbortController | null = null;

  constructor(options: PerformancePlaybackOptions) {
    this.getMotionPort = options.getMotionPort;
    this.playAudio = options.playAudio;
    this.stopAudio = options.stopAudio;
    this.clock =
      options.clock ??
      createPerformancePlaybackClock(options.now ?? (() => performance.now()));
  }

  prepare(plan: PerformancePlan): void {
    const assetId = plan.motion?.assetId ?? null;
    if (
      this.preparation?.planId === plan.planId &&
      this.preparation.assetId === assetId
    ) {
      return;
    }

    if (this.activePlanId && this.activePlanId !== plan.planId) {
      this.generation += 1;
      this.playbackController?.abort();
      this.playbackController = null;
      this.stopAudio();
      this.getMotionPort()?.stopMotion(this.activePlanId);
    }

    this.cancelPreparation();
    this.activePlanId = plan.planId;
    const controller = new AbortController();
    const promise = this.getMotionPort()?.prepareMotion(plan, controller.signal)
      .then((ready) => ready)
      .catch(() => false) ?? Promise.resolve(false);

    this.preparation = { controller, planId: plan.planId, assetId, promise };
  }

  async play(
    plan: PerformancePlan,
    audioSource: AudioPlaybackSource,
    callbacks: PerformancePlaybackCallbacks = {},
  ): Promise<PerformancePlaybackResult | null> {
    const assetId = plan.motion?.assetId ?? null;
    if (
      this.preparation?.planId !== plan.planId ||
      this.preparation.assetId !== assetId
    ) {
      this.prepare(plan);
    }

    const preparation = this.preparation;
    const generation = this.generation;
    const controller = new AbortController();
    this.playbackController = controller;

    try {
      const motionReady = preparation
        ? await waitForPreparation(
            preparation.promise,
            plan.timing.motionPreparationTimeoutMs,
            controller.signal,
            this.clock,
          )
        : false;
      if (!this.isCurrent(plan.planId, generation, controller)) return null;

      const motionPort = this.getMotionPort();
      if (motionReady) callbacks.onMotionReady?.(this.clock.now());

      let motionStartedAt: number | undefined;
      let speechStartedAt: number | undefined;
      await this.playAudio(audioSource, {
        startDelayMs: Math.max(
          motionReady ? plan.timing.motionLeadMs : 0,
          callbacks.presentationLeadMs ?? 0,
        ),
        onComplete: callbacks.onAudioComplete,
        onFirstAudioReady: callbacks.onFirstAudioReady,
        onPlaybackGestureRequired: callbacks.onPlaybackGestureRequired,
        onReadyToStart: () => {
          if (!motionReady || !this.isCurrent(plan.planId, generation, controller)) {
            return false;
          }
          motionStartedAt = motionPort?.startPreparedMotion(plan.planId) ?? undefined;
          if (motionStartedAt !== undefined) {
            callbacks.onMotionStart?.(motionStartedAt);
          }
          return motionStartedAt !== undefined;
        },
        onStart: (startedAt) => {
          if (!this.isCurrent(plan.planId, generation, controller)) return;
          speechStartedAt = startedAt;
          motionPort?.markSpeechStart(plan.planId, startedAt);
          callbacks.onSpeechStart?.(startedAt);
        },
      });
      if (!this.isCurrent(plan.planId, generation, controller)) return null;

      const speechEndedAt = this.clock.now();
      motionPort?.markSpeechEnd(plan.planId, speechEndedAt);
      callbacks.onSpeechEnd?.(speechEndedAt);
      await waitForDelay(
        Math.max(
          plan.timing.postSpeechHoldMs,
          plan.avatarProfile?.expressionHoldMs ?? 0,
        ),
        controller.signal,
        this.clock,
      );
      if (!this.isCurrent(plan.planId, generation, controller)) return null;

      motionPort?.finishMotion(plan.planId);
      if (this.activePlanId === plan.planId) {
        this.activePlanId = null;
        this.cancelPreparation();
      }
      return {
        ...(motionStartedAt === undefined ? {} : { motionStartedAt }),
        ...(speechStartedAt === undefined ? {} : { speechStartedAt }),
        speechEndedAt,
      };
    } catch (error) {
      if (error instanceof PlaybackCancelledError) return null;
      this.stopAudio();
      this.getMotionPort()?.stopMotion(plan.planId);
      throw error;
    } finally {
      if (this.playbackController === controller) {
        this.playbackController = null;
      }
    }
  }

  stop(): void {
    this.generation += 1;
    this.playbackController?.abort();
    this.playbackController = null;
    this.stopAudio();
    if (this.activePlanId) {
      this.getMotionPort()?.stopMotion(this.activePlanId);
    }
    this.activePlanId = null;
    this.cancelPreparation();
  }

  private cancelPreparation(): void {
    this.preparation?.controller.abort();
    this.preparation = null;
  }

  private isCurrent(
    planId: string,
    generation: number,
    controller: AbortController,
  ): boolean {
    return (
      this.activePlanId === planId &&
      this.generation === generation &&
      !controller.signal.aborted
    );
  }
}

function waitForPreparation(
  preparation: Promise<boolean>,
  timeoutMs: number,
  signal: AbortSignal,
  clock: PerformancePlaybackClock,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PlaybackCancelledError());
      return;
    }

    let settled = false;
    const timeout = Math.max(0, Math.round(timeoutMs));
    const timer = clock.setTimeout(() => finish(false), timeout);

    const cleanup = () => {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PlaybackCancelledError());
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    preparation.then(finish, () => finish(false));
  });
}

function waitForDelay(
  delayMs: number,
  signal: AbortSignal,
  clock: PerformancePlaybackClock,
): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PlaybackCancelledError());
      return;
    }

    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      reject(new PlaybackCancelledError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function createPerformancePlaybackClock(
  now: () => number,
): PerformancePlaybackClock {
  return {
    now,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}
