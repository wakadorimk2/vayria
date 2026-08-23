import type {
  AttentionFocus,
  AttentionPosition,
} from '../performer/types.js';
import type { CameraAttentionSnapshot } from './cameraAttentionController.js';
import {
  CAMERA_ATTENTION_CONFIG,
  getCameraAttentionConfidence,
  getReengagingConfidence,
  getUncertainEyePosition,
  clampAttentionPosition,
  isUsableCameraAttention,
} from './attentionMath.js';

export const CAMERA_TRACKING_STATES = [
  'Tracking',
  'Coasting',
  'Uncertain',
  'Lost',
  'Reacquire',
] as const;

export type CameraTrackingState = (typeof CAMERA_TRACKING_STATES)[number];

export interface CameraTrackingInput {
  now: number;
  enabled: boolean;
  snapshot: CameraAttentionSnapshot;
}

export interface CameraTrackingFrame {
  state: CameraTrackingState;
  eyePosition: AttentionPosition | null;
  headPosition: AttentionPosition | null;
  focus: AttentionFocus;
}

export class CameraTrackingController {
  private state: CameraTrackingState = 'Lost';
  private lastDetectedPosition: AttentionPosition | null = null;
  private lastDetectedAt: number | null = null;
  private reacquireStartedAt: number | null = null;

  update(input: CameraTrackingInput): CameraTrackingFrame {
    const now = normalizeTime(input.now);
    if (!input.enabled) {
      this.reset();
      return this.createLostFrame();
    }

    const snapshot = input.snapshot;
    const valid = isUsableCameraAttention(
      snapshot.position,
      snapshot.confidence,
    );
    const nextPosition =
      valid && snapshot.position !== null
        ? clampAttentionPosition(snapshot.position)
        : null;

    if (nextPosition) {
      const hadPreviousDetection = this.lastDetectedAt !== null;
      const previousState = this.state;
      this.lastDetectedPosition = nextPosition;
      this.lastDetectedAt = now;

      if (
        hadPreviousDetection &&
        previousState !== 'Tracking' &&
        previousState !== 'Reacquire'
      ) {
        this.state = 'Reacquire';
        this.reacquireStartedAt = now;
      } else if (!hadPreviousDetection || previousState === 'Tracking') {
        this.state = 'Tracking';
        this.reacquireStartedAt = null;
      }
    }

    if (this.lastDetectedPosition === null || this.lastDetectedAt === null) {
      this.state = 'Lost';
      return this.createLostFrame();
    }

    const missingMs = Math.max(0, now - this.lastDetectedAt);
    if (this.state === 'Reacquire') {
      const reacquireElapsedMs =
        this.reacquireStartedAt === null
          ? CAMERA_ATTENTION_CONFIG.reacquireMs
          : Math.max(0, now - this.reacquireStartedAt);
      if (reacquireElapsedMs >= CAMERA_ATTENTION_CONFIG.reacquireMs) {
        this.state = 'Tracking';
        this.reacquireStartedAt = null;
        return this.createTrackingFrame();
      }
      return this.createReacquireFrame(reacquireElapsedMs);
    }

    if (valid && missingMs < CAMERA_ATTENTION_CONFIG.coastingMs) {
      this.state = 'Tracking';
      return this.createTrackingFrame();
    }

    if (missingMs < CAMERA_ATTENTION_CONFIG.coastingMs) {
      this.state = 'Coasting';
      return this.createCoastingFrame();
    }

    if (missingMs < CAMERA_ATTENTION_CONFIG.lostMs) {
      this.state = 'Uncertain';
      return this.createUncertainFrame(missingMs);
    }

    this.state = 'Lost';
    this.reacquireStartedAt = null;
    return this.createLostFrame();
  }

  reset(): void {
    this.state = 'Lost';
    this.lastDetectedPosition = null;
    this.lastDetectedAt = null;
    this.reacquireStartedAt = null;
  }

  private createTrackingFrame(): CameraTrackingFrame {
    return {
      state: 'Tracking',
      eyePosition: this.lastDetectedPosition,
      headPosition: this.lastDetectedPosition,
      focus: createFocus('focused', 1),
    };
  }

  private createCoastingFrame(): CameraTrackingFrame {
    return {
      state: 'Coasting',
      eyePosition: this.lastDetectedPosition,
      headPosition: this.lastDetectedPosition,
      focus: createFocus('holding', 1),
    };
  }

  private createUncertainFrame(missingMs: number): CameraTrackingFrame {
    return {
      state: 'Uncertain',
      eyePosition: getUncertainEyePosition(
        this.lastDetectedPosition ?? getCenterPosition(),
        missingMs,
      ),
      headPosition: this.lastDetectedPosition,
      focus: createFocus('uncertain', getCameraAttentionConfidence(missingMs)),
    };
  }

  private createLostFrame(): CameraTrackingFrame {
    return {
      state: 'Lost',
      eyePosition: null,
      headPosition: null,
      focus: createFocus('released', 0, 'idle'),
    };
  }

  private createReacquireFrame(elapsedMs: number): CameraTrackingFrame {
    return {
      state: 'Reacquire',
      eyePosition: this.lastDetectedPosition,
      headPosition: this.lastDetectedPosition,
      focus: createFocus(
        'reengaging',
        getReengagingConfidence(elapsedMs),
      ),
    };
  }
}

function createFocus(
  phase: AttentionFocus['phase'],
  confidence: number,
  target: AttentionFocus['target'] = 'user',
): AttentionFocus {
  return {
    target,
    phase,
    confidence: clampConfidence(confidence),
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}

function getCenterPosition(): AttentionPosition {
  return { x: 0.5, y: 0.5 };
}

function normalizeTime(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}
