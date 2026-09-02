export const TTS_PLAYBACK_DIAGNOSTIC_SAMPLE_COUNT = 3;
export const TTS_PLAYBACK_RMS_THRESHOLD = 0.0001;
export const TTS_PLAYBACK_RMS_CONSECUTIVE_FRAMES = 3;

export const TTS_PLAYBACK_DIAGNOSTIC_STRATEGIES = [
  'media-source',
  'media-element-blob',
  'audio-buffer',
] as const;

export type TtsPlaybackDiagnosticStrategy =
  (typeof TTS_PLAYBACK_DIAGNOSTIC_STRATEGIES)[number];

export type TtsPlaybackDiagnosticFailureKind =
  | 'aborted'
  | 'decode_error'
  | 'http_error'
  | 'media_error'
  | 'not_allowed'
  | 'timeout'
  | 'unsupported_media_type';

export interface TtsPlaybackDiagnosticTimestamps {
  current_time_advanced_at: number | null;
  decode_complete_at: number | null;
  ended_at: number | null;
  first_chunk_at: number | null;
  first_nonzero_rms_at: number | null;
  play_called_at: number | null;
  playing_at: number | null;
  request_at: number;
  response_complete_at: number | null;
  response_headers_at: number | null;
}

export interface TtsPlaybackDiagnosticDurations {
  decode: number | null;
  download: number | null;
  firstChunk: number | null;
  playToPlaying: number | null;
  playingToCurrentTime: number | null;
  playingToFirstRms: number | null;
  total: number | null;
}

export interface TtsPlaybackDiagnosticSample {
  backend: string;
  durationsMs: TtsPlaybackDiagnosticDurations;
  failure?: { kind: TtsPlaybackDiagnosticFailureKind; status?: number };
  fixtureId: 'short' | 'normal' | 'long';
  iteration: number;
  mediaType: string;
  rms: {
    activeFrames: number;
    firstNonzeroDetected: boolean;
    max: number;
    totalFrames: number;
  };
  strategy: TtsPlaybackDiagnosticStrategy;
  textLength: number;
  timestamps: TtsPlaybackDiagnosticTimestamps;
}

export interface RmsDiagnosticResult {
  activeFrames: number;
  firstNonzeroAt: number | null;
  max: number;
  totalFrames: number;
}

export class ConsecutiveRmsTracker {
  private activeFrames = 0;
  private consecutiveActiveFrames = 0;
  private firstNonzeroAt: number | null = null;
  private max = 0;
  private totalFrames = 0;

  constructor(
    private readonly threshold = TTS_PLAYBACK_RMS_THRESHOLD,
    private readonly requiredConsecutiveFrames =
      TTS_PLAYBACK_RMS_CONSECUTIVE_FRAMES,
  ) {}

  sample(samples: Float32Array, at: number): number {
    let squaredTotal = 0;
    for (const sample of samples) squaredTotal += sample * sample;
    const rms = samples.length
      ? Math.sqrt(squaredTotal / samples.length)
      : 0;
    this.totalFrames += 1;
    this.max = Math.max(this.max, rms);
    if (rms > this.threshold) {
      this.activeFrames += 1;
      this.consecutiveActiveFrames += 1;
      if (
        this.firstNonzeroAt === null &&
        this.consecutiveActiveFrames >= this.requiredConsecutiveFrames
      ) {
        this.firstNonzeroAt = at;
      }
    } else {
      this.consecutiveActiveFrames = 0;
    }
    return rms;
  }

  result(): RmsDiagnosticResult {
    return {
      activeFrames: this.activeFrames,
      firstNonzeroAt: this.firstNonzeroAt,
      max: this.max,
      totalFrames: this.totalFrames,
    };
  }
}

function durationBetween(
  start: number | null,
  end: number | null,
): number | null {
  if (start === null || end === null) return null;
  return Math.max(0, Math.round(end - start));
}

export function calculatePlaybackDiagnosticDurations(
  timestamps: TtsPlaybackDiagnosticTimestamps,
): TtsPlaybackDiagnosticDurations {
  return {
    decode: durationBetween(
      timestamps.response_complete_at,
      timestamps.decode_complete_at,
    ),
    download: durationBetween(
      timestamps.request_at,
      timestamps.response_complete_at,
    ),
    firstChunk: durationBetween(
      timestamps.request_at,
      timestamps.first_chunk_at,
    ),
    playToPlaying: durationBetween(
      timestamps.play_called_at,
      timestamps.playing_at,
    ),
    playingToCurrentTime: durationBetween(
      timestamps.playing_at,
      timestamps.current_time_advanced_at,
    ),
    playingToFirstRms: durationBetween(
      timestamps.playing_at,
      timestamps.first_nonzero_rms_at,
    ),
    total: durationBetween(timestamps.request_at, timestamps.ended_at),
  };
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return Math.round(sorted[middle]);
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function maximum(values: readonly number[]): number | null {
  return values.length ? Math.round(Math.max(...values)) : null;
}

export interface TtsPlaybackDiagnosticSummary {
  fixtureId: TtsPlaybackDiagnosticSample['fixtureId'];
  firstRmsCount: number;
  firstRmsDelayMs: { max: number | null; median: number | null };
  sampleCount: number;
  strategy: TtsPlaybackDiagnosticStrategy;
}

export function summarizePlaybackDiagnostics(
  samples: readonly TtsPlaybackDiagnosticSample[],
): TtsPlaybackDiagnosticSummary[] {
  const summaries: TtsPlaybackDiagnosticSummary[] = [];
  for (const strategy of TTS_PLAYBACK_DIAGNOSTIC_STRATEGIES) {
    for (const fixtureId of ['short', 'normal', 'long'] as const) {
      const matching = samples.filter(
        (sample) =>
          sample.strategy === strategy && sample.fixtureId === fixtureId,
      );
      const delays = matching.flatMap((sample) =>
        sample.durationsMs.playingToFirstRms === null
          ? []
          : [sample.durationsMs.playingToFirstRms],
      );
      summaries.push({
        fixtureId,
        firstRmsCount: matching.filter(
          (sample) => sample.rms.firstNonzeroDetected,
        ).length,
        firstRmsDelayMs: {
          max: maximum(delays),
          median: median(delays),
        },
        sampleCount: matching.length,
        strategy,
      });
    }
  }
  return summaries;
}
