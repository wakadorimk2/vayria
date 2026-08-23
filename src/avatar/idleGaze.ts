import { MathUtils, Object3D, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';

export const IDLE_GAZE_TIMING = {
  approachSeconds: 0.18,
  maxDeltaSeconds: 0.1,
  maxHorizontalOffsetRatio: 0.05,
  maxVerticalOffsetRatio: 0.025,
  minHoldSeconds: 0.6,
  minWaitSeconds: 5,
  returnSeconds: 0.25,
  maxHoldSeconds: 1.8,
  maxWaitSeconds: 14,
  fallbackHeadYawDegrees: 0.6,
} as const;

export type IdleGazePhase = 'waiting' | 'glancing' | 'returning';

export interface IdleGazeFrame {
  fallbackHeadYawBias: number;
  isLookingAtViewer: boolean;
  phase: IdleGazePhase;
}

type RandomSource = () => number;

export class IdleGazeController {
  private readonly gazeTarget = new Object3D();
  private readonly neutralTarget = new Vector3();
  private readonly currentTarget = new Vector3();
  private readonly desiredTarget = new Vector3();
  private readonly performanceStartTarget = new Vector3();
  private readonly random: RandomSource;
  private readonly modelHeight: number;
  private enabled = false;
  private disposed = false;
  private gazeHoldSeconds = 0;
  private nextGazeSeconds: number;
  private phase: IdleGazePhase = 'waiting';
  private phaseElapsedSeconds = 0;
  private hasNeutralTarget = false;
  private performanceActive = false;

  constructor(
    private readonly vrm: VRM,
    modelHeight = 1,
    random: RandomSource = Math.random,
  ) {
    this.modelHeight = Math.max(
      Number.isFinite(modelHeight) ? modelHeight : 1,
      0.1,
    );
    this.random = random;
    this.nextGazeSeconds = this.randomBetween(
      IDLE_GAZE_TIMING.minWaitSeconds,
      IDLE_GAZE_TIMING.maxWaitSeconds,
    );

    if (vrm.lookAt) {
      vrm.scene.updateMatrixWorld(true);
      vrm.lookAt.getLookAtWorldPosition(this.neutralTarget);
      this.currentTarget.copy(this.neutralTarget);
      this.hasNeutralTarget = true;
    }
  }

  update(
    deltaSeconds: number,
    viewerTarget: Vector3,
    enabled: boolean,
    performanceTarget: Vector3 | null = null,
  ): IdleGazeFrame {
    if (this.disposed) return this.createFrame();

    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      IDLE_GAZE_TIMING.maxDeltaSeconds,
    );

    if (performanceTarget) {
      this.updatePerformanceGaze(safeDelta, performanceTarget);
      return this.createFrame();
    }

    if (this.performanceActive) {
      this.performanceActive = false;
      this.beginReturnToNeutral();
    }

    if (!enabled) {
      this.enabled = false;
      if (this.phase === 'glancing') {
        this.beginReturnToNeutral();
      }
      if (this.phase === 'returning') {
        this.updateReturnTarget();
        this.phaseElapsedSeconds += safeDelta;
        if (this.phaseElapsedSeconds >= IDLE_GAZE_TIMING.returnSeconds) {
          this.finishGaze();
        }
      }
      return this.createFrame();
    }

    this.enabled = true;

    if (this.phase === 'waiting') {
      this.phaseElapsedSeconds += safeDelta;
      if (this.phaseElapsedSeconds >= this.nextGazeSeconds) {
        this.beginGaze(viewerTarget);
      }
    } else if (this.phase === 'glancing') {
      this.updateGlanceTarget();
      this.phaseElapsedSeconds += safeDelta;
      if (
        this.phaseElapsedSeconds >=
        IDLE_GAZE_TIMING.approachSeconds + this.gazeHoldSeconds
      ) {
        this.phase = 'returning';
        this.phaseElapsedSeconds = 0;
      }
    } else {
      this.updateReturnTarget();
      this.phaseElapsedSeconds += safeDelta;
      if (this.phaseElapsedSeconds >= IDLE_GAZE_TIMING.returnSeconds) {
        this.finishGaze();
      }
    }

    return this.createFrame();
  }

  reset(): void {
    if (this.disposed) return;

    this.clearLookAtTarget();
    this.phase = 'waiting';
    this.phaseElapsedSeconds = 0;
    this.gazeHoldSeconds = 0;
    this.performanceActive = false;
    this.nextGazeSeconds = this.randomBetween(
      IDLE_GAZE_TIMING.minWaitSeconds,
      IDLE_GAZE_TIMING.maxWaitSeconds,
    );
    if (this.hasNeutralTarget) {
      this.currentTarget.copy(this.neutralTarget);
    }
  }

  getNeutralTarget(target: Vector3): Vector3 {
    if (this.hasNeutralTarget) {
      target.copy(this.neutralTarget);
    } else {
      target.set(0, 0, 0);
    }
    return target;
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.enabled = false;
  }

  private beginGaze(viewerTarget: Vector3): void {
    this.desiredTarget.copy(viewerTarget);
    this.desiredTarget.x +=
      this.randomBetween(-1, 1) *
      this.modelHeight *
      IDLE_GAZE_TIMING.maxHorizontalOffsetRatio;
    this.desiredTarget.y +=
      this.randomBetween(-1, 1) *
      this.modelHeight *
      IDLE_GAZE_TIMING.maxVerticalOffsetRatio;
    this.gazeHoldSeconds = this.randomBetween(
      IDLE_GAZE_TIMING.minHoldSeconds,
      IDLE_GAZE_TIMING.maxHoldSeconds,
    );
    this.phase = 'glancing';
    this.phaseElapsedSeconds = 0;

    if (this.vrm.lookAt && this.hasNeutralTarget) {
      this.currentTarget.copy(this.neutralTarget);
      this.gazeTarget.position.copy(this.currentTarget);
      this.vrm.lookAt.target = this.gazeTarget;
    }
  }

  private updatePerformanceGaze(
    deltaSeconds: number,
    performanceTarget: Vector3,
  ): void {
    if (!this.performanceActive) {
      this.performanceActive = true;
      this.performanceStartTarget.copy(this.currentTarget);
      this.phase = 'glancing';
      this.phaseElapsedSeconds = 0;
      this.gazeHoldSeconds = 0;

      if (this.vrm.lookAt && this.hasNeutralTarget) {
        this.gazeTarget.position.copy(this.currentTarget);
        this.vrm.lookAt.target = this.gazeTarget;
      }
    }

    this.desiredTarget.copy(performanceTarget);
    this.phaseElapsedSeconds += deltaSeconds;
    const progress = MathUtils.smoothstep(
      this.phaseElapsedSeconds,
      0,
      IDLE_GAZE_TIMING.approachSeconds,
    );
    this.currentTarget.lerpVectors(
      this.performanceStartTarget,
      this.desiredTarget,
      progress,
    );
    this.gazeTarget.position.copy(this.currentTarget);
  }

  private updateGlanceTarget(): void {
    if (!this.vrm.lookAt || !this.hasNeutralTarget) return;

    const progress = MathUtils.smoothstep(
      this.phaseElapsedSeconds,
      0,
      IDLE_GAZE_TIMING.approachSeconds,
    );
    this.currentTarget.lerpVectors(
      this.neutralTarget,
      this.desiredTarget,
      progress,
    );
    this.gazeTarget.position.copy(this.currentTarget);
  }

  private updateReturnTarget(): void {
    if (!this.vrm.lookAt || !this.hasNeutralTarget) return;

    const progress = MathUtils.smoothstep(
      this.phaseElapsedSeconds,
      0,
      IDLE_GAZE_TIMING.returnSeconds,
    );
    this.currentTarget.lerpVectors(
      this.desiredTarget,
      this.neutralTarget,
      progress,
    );
    this.gazeTarget.position.copy(this.currentTarget);
  }

  private beginReturnToNeutral(): void {
    if (this.phase === 'waiting' || this.phase === 'returning') return;

    this.desiredTarget.copy(this.currentTarget);
    this.phase = 'returning';
    this.phaseElapsedSeconds = 0;
    this.gazeHoldSeconds = 0;
  }

  private finishGaze(): void {
    this.performanceActive = false;
    this.clearLookAtTarget();
    this.phase = 'waiting';
    this.phaseElapsedSeconds = 0;
    this.gazeHoldSeconds = 0;
    this.nextGazeSeconds = this.randomBetween(
      IDLE_GAZE_TIMING.minWaitSeconds,
      IDLE_GAZE_TIMING.maxWaitSeconds,
    );
    if (this.hasNeutralTarget) {
      this.currentTarget.copy(this.neutralTarget);
    }
  }

  private clearLookAtTarget(): void {
    if (!this.vrm.lookAt || this.vrm.lookAt.target !== this.gazeTarget) {
      return;
    }

    this.vrm.lookAt.target = null;
    this.vrm.lookAt.reset();
  }

  private createFrame(): IdleGazeFrame {
    const isLookingAtViewer = this.phase !== 'waiting';
    if (this.vrm.lookAt || !isLookingAtViewer) {
      return {
        fallbackHeadYawBias: 0,
        isLookingAtViewer,
        phase: this.phase,
      };
    }

    const fallbackProgress =
      this.phase === 'glancing'
        ? MathUtils.smoothstep(
            this.phaseElapsedSeconds,
            0,
            IDLE_GAZE_TIMING.approachSeconds,
          )
        : 1 -
          MathUtils.smoothstep(
            this.phaseElapsedSeconds,
            0,
            IDLE_GAZE_TIMING.returnSeconds,
          );

    return {
      fallbackHeadYawBias:
        IDLE_GAZE_TIMING.fallbackHeadYawDegrees * fallbackProgress,
      isLookingAtViewer,
      phase: this.phase,
    };
  }

  private randomBetween(min: number, max: number): number {
    const value = this.random();
    const normalized = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 1)
      : 0.5;
    return min + (max - min) * normalized;
  }
}
