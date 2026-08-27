import {
  ATTENTION_ENERGY_CONFIG,
  calculateDragEnergyTarget,
  moveAttentionEnergy,
} from './attentionEnergyController.js';

export type DragAttentionPhase = 'idle' | 'acquire' | 'priority';

export type DragAttentionRandom = () => number;

export const DRAG_ATTENTION_SALIENCE = 0.85;
export const DRAG_ATTENTION_MIN_DWELL_MS = 200;
export const DRAG_ATTENTION_MAX_ACQUIRE_MS = 1_200;
export const DRAG_ATTENTION_TICK_MS = 50;
export const DRAG_ATTENTION_POST_END_HOLD_MS = 300;
export const DRAG_ATTENTION_MIN_GAZE_STRENGTH = 0.33;
export const DRAG_ATTENTION_START_GAZE_STRENGTH = 0.55;
export const DRAG_ATTENTION_MAX_GAZE_STRENGTH = 0.55;

const DRAG_ATTENTION_HAZARD_WINDOWS = [
  { endMs: 500, hazardPerSecond: 0.5 },
  { endMs: 800, hazardPerSecond: 1.5 },
  { endMs: Number.POSITIVE_INFINITY, hazardPerSecond: 4 },
] as const;

export interface DragAttentionSnapshot {
  readonly phase: DragAttentionPhase;
  readonly elapsedMs: number;
  readonly gazeStrength: number;
  readonly attentionEnergy: number;
}

/**
 * Models the task-driven transition from a guaranteed card acquire to a
 * softer priority hint. The release timing is stochastic, but the initial
 * acquire and the minimum dwell are deterministic.
 */
export class DragAttentionController {
  private phase: DragAttentionPhase = 'idle';
  private elapsedMs = 0;
  private gazeStrength = 0;
  private attentionEnergy = 0;

  start(currentGazeStrength = 0.25): DragAttentionSnapshot {
    this.phase = 'acquire';
    this.elapsedMs = 0;
    this.attentionEnergy = Math.max(
      clampStrength(currentGazeStrength),
      DRAG_ATTENTION_START_GAZE_STRENGTH,
    );
    this.gazeStrength = this.attentionEnergy;
    return this.snapshot();
  }

  update(
    deltaMs: number,
    random: DragAttentionRandom = Math.random,
    speedPxPerSecond = 0,
  ): DragAttentionSnapshot {
    const delta = clampDeltaMs(deltaMs);
    if (this.phase === 'idle') return this.snapshot();
    if (this.phase === 'priority') {
      this.elapsedMs += delta;
      this.updateAttentionEnergy(delta, speedPxPerSecond);
      return this.snapshot();
    }

    const startMs = this.elapsedMs;
    const endMs = Math.min(
      DRAG_ATTENTION_MAX_ACQUIRE_MS,
      startMs + delta,
    );
    this.elapsedMs = endMs;
    this.updateAttentionEnergy(delta, speedPxPerSecond);

    if (endMs >= DRAG_ATTENTION_MAX_ACQUIRE_MS) {
      this.beginPriority();
      return this.snapshot();
    }

    const hazardIntegral = integrateReleaseHazard(startMs, endMs);
    const releaseProbability = 1 - Math.exp(-hazardIntegral);
    if (
      endMs > DRAG_ATTENTION_MIN_DWELL_MS &&
      releaseProbability > 0 &&
      isRandomHit(random(), releaseProbability)
    ) {
      this.beginPriority();
    }

    return this.snapshot();
  }

  end(): DragAttentionSnapshot {
    this.phase = 'idle';
    this.elapsedMs = 0;
    this.gazeStrength = 0;
    this.attentionEnergy = 0;
    return this.snapshot();
  }

  snapshot(): DragAttentionSnapshot {
    return {
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      gazeStrength: this.gazeStrength,
      attentionEnergy: this.attentionEnergy,
    };
  }

  private beginPriority(): void {
    this.phase = 'priority';
  }

  private updateAttentionEnergy(
    deltaMs: number,
    speedPxPerSecond: number,
  ): void {
    const targetEnergy = calculateDragEnergyTarget(speedPxPerSecond);
    this.attentionEnergy = moveAttentionEnergy(
      this.attentionEnergy,
      targetEnergy,
      deltaMs,
      ATTENTION_ENERGY_CONFIG.dragResponseMs,
    );
    this.gazeStrength = this.attentionEnergy;
  }
}

export function getDragAttentionReleaseHazard(
  elapsedMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < DRAG_ATTENTION_MIN_DWELL_MS) {
    return 0;
  }

  for (const window of DRAG_ATTENTION_HAZARD_WINDOWS) {
    if (elapsedMs < window.endMs) return window.hazardPerSecond;
  }
  return 0;
}

function integrateReleaseHazard(startMs: number, endMs: number): number {
  if (endMs <= startMs || endMs <= DRAG_ATTENTION_MIN_DWELL_MS) {
    return 0;
  }

  let integral = 0;
  let cursorMs = Math.max(startMs, DRAG_ATTENTION_MIN_DWELL_MS);
  while (cursorMs < endMs) {
    const hazard = getDragAttentionReleaseHazard(cursorMs);
    if (hazard <= 0) break;

    const nextBoundaryMs = getNextHazardBoundary(cursorMs, endMs);
    integral += hazard * ((nextBoundaryMs - cursorMs) / 1_000);
    cursorMs = nextBoundaryMs;
  }
  return integral;
}

function getNextHazardBoundary(cursorMs: number, endMs: number): number {
  for (const window of DRAG_ATTENTION_HAZARD_WINDOWS) {
    if (cursorMs < window.endMs) {
      return Math.min(endMs, window.endMs);
    }
  }
  return endMs;
}

function clampDeltaMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function isRandomHit(value: number, probability: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value < Math.max(0, Math.min(probability, 1))
  );
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
