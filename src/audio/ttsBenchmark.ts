export const TTS_BENCHMARK_SAMPLE_COUNT = 10;

export const TTS_BENCHMARK_FIXTURES = [
  { id: 'short', text: 'うん、わかったよ。' },
  {
    id: 'normal',
    text: 'そのカード、今の話にちょうど合いそう。少し考えてから、私なりの答えを話すね。',
  },
  {
    id: 'long',
    text: '展示で初めて会った人にも伝わるように、いま起きていることを順番に説明するね。選んだカードは会話の雰囲気だけでなく、返事の内容や話し方にも少しずつ影響しているの。だから同じ質問でも、手元にあるカードが変わると、私が注目する部分や言葉の選び方も変わっていくんだよ。',
  },
] as const;

export type TtsBenchmarkFixtureId =
  (typeof TTS_BENCHMARK_FIXTURES)[number]['id'];

const TTS_FALLBACK_REASONS = new Set([
  'authentication',
  'configuration',
  'first_audio_timeout',
  'invalid_request',
  'model',
  'provider',
  'quota',
  'rate_limit',
  'timeout',
] as const);

export type TtsFallbackReason =
  | 'authentication'
  | 'configuration'
  | 'first_audio_timeout'
  | 'invalid_request'
  | 'model'
  | 'provider'
  | 'quota'
  | 'rate_limit'
  | 'timeout';

export interface TtsFallbackMetadata {
  from: 'aivis-cloud';
  reason: TtsFallbackReason;
}

interface HeaderReader {
  get(name: string): string | null;
}

export function readTtsFallback(
  headers: HeaderReader,
): TtsFallbackMetadata | undefined {
  const from = headers.get('X-Vayria-Tts-Fallback-From');
  const reason = headers.get('X-Vayria-Tts-Fallback-Reason');
  if (
    from !== 'aivis-cloud' ||
    !reason ||
    !TTS_FALLBACK_REASONS.has(reason as TtsFallbackReason)
  ) {
    return undefined;
  }
  return { from, reason: reason as TtsFallbackReason };
}

export interface TtsBenchmarkSample {
  backend: string;
  durationsMs: {
    firstAudio: number;
    synthesis: number;
    ttfa: number;
  };
  fixtureId: TtsBenchmarkFixtureId;
  fallback?: TtsFallbackMetadata;
  iteration: number;
  textLength: number;
  timestamps: {
    first_audio_at: number;
    playback_started_at: number;
    text_ready_at: number;
    tts_completed_at: number;
    tts_request_at: number;
  };
}

export interface TtsBenchmarkSummary {
  fallbackCount: number;
  fixtureId: TtsBenchmarkFixtureId;
  firstAudioMs: { p50: number; p95: number };
  sampleCount: number;
  synthesisMs: { p50: number; p95: number };
  ttfaMs: { p50: number; p95: number };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
}

function summarizeValues(values: readonly number[]) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

export function summarizeTtsBenchmark(
  samples: readonly TtsBenchmarkSample[],
): TtsBenchmarkSummary[] {
  return TTS_BENCHMARK_FIXTURES.map((fixture) => {
    const fixtureSamples = samples.filter(
      (sample) => sample.fixtureId === fixture.id,
    );
    return {
      fixtureId: fixture.id,
      fallbackCount: fixtureSamples.filter((sample) => sample.fallback).length,
      sampleCount: fixtureSamples.length,
      firstAudioMs: summarizeValues(
        fixtureSamples.map((sample) => sample.durationsMs.firstAudio),
      ),
      synthesisMs: summarizeValues(
        fixtureSamples.map((sample) => sample.durationsMs.synthesis),
      ),
      ttfaMs: summarizeValues(
        fixtureSamples.map((sample) => sample.durationsMs.ttfa),
      ),
    };
  });
}
