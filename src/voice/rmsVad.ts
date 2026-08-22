import { PCM_CHUNK_DURATION_MS } from './pcm16.js';
import {
  DEFAULT_VAD_THRESHOLD,
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  clampVadThreshold,
} from './audioLab.js';
import type { AudioEndpointMs } from './audioLab.js';

export const VAD_NOISE_FLOOR_SCORE = 0.005;
export const VAD_PRE_ROLL_CHUNK_COUNT = 1;
export const VAD_HANGOVER_CHUNK_COUNT = 3;
export const VAD_CANDIDATE_END_CHUNK_COUNT = 2;

export type RmsVadEvent =
  | {
      type: 'speech_started';
      at: number;
    }
  | {
      type: 'speech_ended';
      at: number;
    }
  | {
      type: 'rejected';
      at: number;
      candidateDurationMs: number;
      maxScore: number;
      reason: 'below-threshold' | 'stop-before-threshold';
    };

export interface RmsVadChunkResult {
  audioLevel: number;
  score: number;
  speechActive: boolean;
  forwardedChunks: ArrayBuffer[];
  events: RmsVadEvent[];
}

export interface RmsVadOptions {
  hangoverChunkCount?: number;
}

export function getVadHangoverChunkCount(endpointMs: AudioEndpointMs): number {
  return Math.max(1, Math.round(endpointMs / PCM_CHUNK_DURATION_MS));
}

function readPcm16Sample(view: DataView, offset: number): number {
  return view.getInt16(offset, true) / 32_768;
}

export function calculatePcm16Rms(pcm: ArrayBuffer): number {
  if (pcm.byteLength < 2) return 0;

  const view = new DataView(pcm);
  let squaredTotal = 0;
  let sampleCount = 0;
  for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
    const sample = readPcm16Sample(view, offset);
    squaredTotal += sample * sample;
    sampleCount += 1;
  }

  return sampleCount > 0 ? Math.sqrt(squaredTotal / sampleCount) : 0;
}

type DetectorState = 'idle' | 'candidate' | 'speech';

export class RmsVad {
  private threshold: number;
  private readonly hangoverChunkCount: number;
  private candidateNoiseFloor = VAD_NOISE_FLOOR_SCORE;
  private state: DetectorState = 'idle';
  private readonly recentChunks: ArrayBuffer[] = [];
  private candidatePreRoll: ArrayBuffer[] = [];
  private candidateChunks: ArrayBuffer[] = [];
  private candidateBelowFloorCount = 0;
  private candidateMaxScore = 0;
  private speechBelowThresholdCount = 0;
  private speechChunkCount = 0;

  constructor(threshold = DEFAULT_VAD_THRESHOLD, options: RmsVadOptions = {}) {
    this.threshold = clampVadThreshold(threshold);
    this.hangoverChunkCount = Number.isFinite(options.hangoverChunkCount)
      ? Math.max(1, Math.floor(options.hangoverChunkCount!))
      : VAD_HANGOVER_CHUNK_COUNT;
  }

  getThreshold(): number {
    return this.threshold;
  }

  isIdle(): boolean {
    return this.state === 'idle';
  }

  setThreshold(value: number): void {
    this.threshold = Math.max(
      VAD_THRESHOLD_MIN,
      Math.min(clampVadThreshold(value), VAD_THRESHOLD_MAX),
    );
  }

  setEffectiveThreshold(value: number): void {
    this.threshold = Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  setCandidateNoiseFloor(value: number): void {
    this.candidateNoiseFloor = Math.max(0, value);
  }

  process(pcm: ArrayBuffer, at = Date.now()): RmsVadChunkResult {
    const score = calculatePcm16Rms(pcm);
    const events: RmsVadEvent[] = [];
    let forwardedChunks: ArrayBuffer[] = [];
    let speechActive = false;

    if (this.state === 'idle') {
      if (score >= VAD_NOISE_FLOOR_SCORE) {
        this.state = 'candidate';
        this.candidatePreRoll = [...this.recentChunks];
        this.candidateChunks = [pcm];
        this.candidateBelowFloorCount = 0;
        this.candidateMaxScore = score;

        if (score >= this.threshold) {
          this.state = 'speech';
          this.speechChunkCount = this.candidateChunks.length;
          this.speechBelowThresholdCount = 0;
          forwardedChunks = [
            ...this.candidatePreRoll,
            ...this.candidateChunks,
          ];
          events.push({ type: 'speech_started', at });
          this.clearCandidate();
          speechActive = true;
        }
      }
    } else if (this.state === 'candidate') {
      this.candidateChunks.push(pcm);
      this.candidateMaxScore = Math.max(this.candidateMaxScore, score);

      if (score >= this.threshold) {
        this.state = 'speech';
        this.speechChunkCount = this.candidateChunks.length;
        this.speechBelowThresholdCount = 0;
        forwardedChunks = [
          ...this.candidatePreRoll,
          ...this.candidateChunks,
        ];
        events.push({ type: 'speech_started', at });
        this.clearCandidate();
        speechActive = true;
      } else if (score < this.candidateNoiseFloor) {
        this.candidateBelowFloorCount += 1;
        if (this.candidateBelowFloorCount >= VAD_CANDIDATE_END_CHUNK_COUNT) {
          events.push({
            type: 'rejected',
            at,
            candidateDurationMs:
              this.candidateChunks.length * PCM_CHUNK_DURATION_MS,
            maxScore: this.candidateMaxScore,
            reason: 'below-threshold',
          });
          this.clearCandidate();
          this.state = 'idle';
        }
      } else {
        this.candidateBelowFloorCount = 0;
      }
    } else {
      forwardedChunks = [pcm];
      speechActive = true;
      this.speechChunkCount += 1;
      if (score < this.threshold) {
        this.speechBelowThresholdCount += 1;
      } else {
        this.speechBelowThresholdCount = 0;
      }

      if (this.speechBelowThresholdCount >= this.hangoverChunkCount) {
        events.push({ type: 'speech_ended', at });
        this.state = 'idle';
        this.speechBelowThresholdCount = 0;
        this.speechChunkCount = 0;
        speechActive = true;
      }
    }

    this.rememberChunk(pcm);
    return {
      audioLevel: score,
      score,
      speechActive,
      forwardedChunks,
      events,
    };
  }

  flush(at = Date.now()): RmsVadEvent[] {
    const events: RmsVadEvent[] = [];
    if (this.state === 'candidate' && this.candidateChunks.length > 0) {
      events.push({
        type: 'rejected',
        at,
        candidateDurationMs:
          this.candidateChunks.length * PCM_CHUNK_DURATION_MS,
        maxScore: this.candidateMaxScore,
        reason: 'stop-before-threshold',
      });
    } else if (this.state === 'speech') {
      events.push({ type: 'speech_ended', at });
    }
    this.reset();
    return events;
  }

  reset(): void {
    this.state = 'idle';
    this.recentChunks.length = 0;
    this.clearCandidate();
    this.speechBelowThresholdCount = 0;
    this.speechChunkCount = 0;
  }

  private clearCandidate(): void {
    this.candidatePreRoll = [];
    this.candidateChunks = [];
    this.candidateBelowFloorCount = 0;
    this.candidateMaxScore = 0;
  }

  private rememberChunk(pcm: ArrayBuffer): void {
    this.recentChunks.push(pcm);
    while (this.recentChunks.length > VAD_PRE_ROLL_CHUNK_COUNT) {
      this.recentChunks.shift();
    }
  }
}
