import type { PlayAudio } from '../audio/useAudioLipSync.js';
import type { PerformancePlan } from './types.js';

export interface PerformanceMotionPort {
  prepareMotion(
    plan: PerformancePlan,
    signal?: AbortSignal,
  ): Promise<boolean>;
  startPreparedMotion(planId: string): number | null;
  finishMotion(planId: string): void;
  stopMotion(planId: string): void;
}

export interface PerformancePlaybackCallbacks {
  onMotionReady?: (readyAt: number) => void;
  onMotionStart?: (startedAt: number) => void;
  onSpeechStart?: (startedAt: number) => void;
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
    audioData: ArrayBuffer,
    callbacks?: PerformancePlaybackCallbacks,
  ): Promise<PerformancePlaybackResult | null>;
  stop(): void;
}

interface PerformancePlaybackOptions {
  getMotionPort: () => PerformanceMotionPort | null;
  playAudio: PlayAudio;
  stopAudio: () => void;
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
  private readonly now: () => number;
  private generation = 0;
  private activePlanId: string | null = null;
  private preparation: PreparationState | null = null;
  private playbackController: AbortController | null = null;

  constructor(options: PerformancePlaybackOptions) {
    this.getMotionPort = options.getMotionPort;
    this.playAudio = options.playAudio;
    this.stopAudio = options.stopAudio;
    this.now = options.now ?? (() => performance.now());
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
    audioData: ArrayBuffer,
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
          )
        : false;
      if (!this.isCurrent(plan.planId, generation, controller)) return null;

      const motionPort = this.getMotionPort();
      if (motionReady) callbacks.onMotionReady?.(this.now());

      let motionStartedAt: number | undefined;
      let speechStartedAt: number | undefined;
      await this.playAudio(audioData, {
        startDelayMs: motionReady ? plan.timing.motionLeadMs : 0,
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
          speechStartedAt = startedAt;
          callbacks.onSpeechStart?.(startedAt);
        },
      });
      if (!this.isCurrent(plan.planId, generation, controller)) return null;

      const speechEndedAt = this.now();
      await waitForDelay(plan.timing.postSpeechHoldMs, controller.signal);
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
  ): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PlaybackCancelledError());
      return;
    }

    let settled = false;
    const timeout = Math.max(0, Math.round(timeoutMs));
    const timer = setTimeout(() => finish(false), timeout);

    const cleanup = () => {
      clearTimeout(timer);
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

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PlaybackCancelledError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      reject(new PlaybackCancelledError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}
