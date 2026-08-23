import type { AttentionPosition } from '../performer/types.js';
import {
  CAMERA_ATTENTION_CONFIG,
  smoothAttentionPosition,
} from './attentionMath.js';

export interface AttentionVisualTargets {
  eyePosition: AttentionPosition | null;
  headPosition: AttentionPosition | null;
}

export class AttentionVisualSmoother {
  private eyePosition: AttentionPosition | null = null;
  private headPosition: AttentionPosition | null = null;

  update(
    deltaSeconds: number,
    targets: AttentionVisualTargets,
  ): AttentionVisualTargets {
    const deltaMs = toDeltaMs(deltaSeconds);
    if (targets.eyePosition === null && targets.headPosition === null) {
      this.reset();
      return { eyePosition: null, headPosition: null };
    }

    this.eyePosition = targets.eyePosition
      ? smoothAttentionPosition(
          this.eyePosition ?? getCenterPosition(),
          targets.eyePosition,
          deltaMs,
          CAMERA_ATTENTION_CONFIG.visualSmoothingMs,
        )
      : null;
    this.headPosition = targets.headPosition
      ? smoothAttentionPosition(
          this.headPosition ?? getCenterPosition(),
          targets.headPosition,
          deltaMs,
          CAMERA_ATTENTION_CONFIG.visualSmoothingMs,
        )
      : null;

    return {
      eyePosition: this.eyePosition,
      headPosition: this.headPosition,
    };
  }

  reset(): void {
    this.eyePosition = null;
    this.headPosition = null;
  }
}

function getCenterPosition(): AttentionPosition {
  return { x: 0.5, y: 0.5 };
}

function toDeltaMs(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds)) return 0;
  return Math.max(0, deltaSeconds) * 1_000;
}
