import {
  ADAPTIVE_NOISE_FLOOR_ALPHA,
  ADAPTIVE_NOISE_FLOOR_INITIAL,
  ADAPTIVE_NOISE_FLOOR_MULTIPLIER,
  DEFAULT_VAD_THRESHOLD,
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  clampVadThreshold,
} from './audioLab.js';
import {
  calculatePcm16Rms,
  RmsVad,
  type RmsVadChunkResult,
} from './rmsVad.js';

export interface AdaptiveRmsVadChunkResult extends RmsVadChunkResult {
  noiseFloor: number;
  effectiveThreshold: number;
  vadThreshold: number;
}

export interface AdaptiveRmsVadOptions {
  noiseFloorMultiplier?: number;
  hangoverChunkCount?: number;
}

export class AdaptiveRmsVad {
  private readonly vad: RmsVad;
  private readonly noiseFloorMultiplier: number;
  private vadThreshold: number;
  private noiseFloor = ADAPTIVE_NOISE_FLOOR_INITIAL;
  private ttsPlaying = false;

  constructor(
    vadThreshold = DEFAULT_VAD_THRESHOLD,
    options: AdaptiveRmsVadOptions = {},
  ) {
    this.noiseFloorMultiplier = Number.isFinite(options.noiseFloorMultiplier)
      ? Math.max(1, options.noiseFloorMultiplier!)
      : ADAPTIVE_NOISE_FLOOR_MULTIPLIER;
    this.vadThreshold = clampVadThreshold(vadThreshold);
    this.vad = new RmsVad(this.getEffectiveThreshold(), {
      hangoverChunkCount: options.hangoverChunkCount,
    });
  }

  getThreshold(): number {
    return this.vadThreshold;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  getEffectiveThreshold(): number {
    return Math.max(
      this.vadThreshold,
      this.noiseFloor * this.noiseFloorMultiplier,
    );
  }

  setThreshold(value: number): void {
    this.vadThreshold = Math.max(
      VAD_THRESHOLD_MIN,
      Math.min(clampVadThreshold(value), VAD_THRESHOLD_MAX),
    );
    this.vad.setEffectiveThreshold(this.getEffectiveThreshold());
  }

  setTtsPlaying(isPlaying: boolean): void {
    this.ttsPlaying = isPlaying;
  }

  process(pcm: ArrayBuffer, at = Date.now()): AdaptiveRmsVadChunkResult {
    const score = calculatePcm16Rms(pcm);
    const thresholdBeforeUpdate = this.getEffectiveThreshold();
    if (
      this.vad.isIdle() &&
      !this.ttsPlaying &&
      score < thresholdBeforeUpdate
    ) {
      this.noiseFloor =
        this.noiseFloor * (1 - ADAPTIVE_NOISE_FLOOR_ALPHA) +
        score * ADAPTIVE_NOISE_FLOOR_ALPHA;
    }

    const effectiveThreshold = this.getEffectiveThreshold();
    this.vad.setCandidateNoiseFloor(this.noiseFloor);
    this.vad.setEffectiveThreshold(effectiveThreshold);
    const result = this.vad.process(pcm, at);
    return {
      ...result,
      noiseFloor: this.noiseFloor,
      effectiveThreshold,
      vadThreshold: this.vadThreshold,
    };
  }

  flush(at = Date.now()) {
    return this.vad.flush(at);
  }

  reset(): void {
    this.vad.reset();
    this.noiseFloor = ADAPTIVE_NOISE_FLOOR_INITIAL;
    this.vad.setCandidateNoiseFloor(this.noiseFloor);
  }
}
