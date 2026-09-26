import type {
  StreamBenchProviderInfo,
  StreamBenchRunResult,
  StreamVisionProviderId,
} from './streamContract.js';

export interface StreamBenchProviderSummary {
  providerId: StreamVisionProviderId;
  model: string;
  sampleCount: number;
  errorCount: number;
  jsonOkCount: number;
  parseOkCount: number;
  changedScoreCount: number;
  changedCorrectCount: number;
  eventScoreCount: number;
  eventHitCount: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
}

export function percentile(values: readonly number[], rank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function changedCorrect(result: StreamBenchRunResult): boolean | null {
  if (result.expected?.changed === null || result.expected === undefined) {
    return null;
  }
  if (result.observation === null) return false;
  return result.observation.changed === result.expected.changed;
}

function eventHit(result: StreamBenchRunResult): boolean | null {
  const expected = result.expected?.eventKinds ?? [];
  if (expected.length === 0) return null;
  if (result.observation === null) return false;
  const observed = new Set(result.observation.events.map((event) => event.kind));
  return expected.some((kind) => observed.has(kind));
}

export function summarizeStreamBench(
  results: readonly StreamBenchRunResult[],
  providers: readonly StreamBenchProviderInfo[],
): StreamBenchProviderSummary[] {
  return providers.map((provider) => {
    const scored = results.filter(
      (result) => result.providerId === provider.id,
    );
    const latencies = scored
      .filter((result) => result.jsonOk)
      .map((result) => result.latencyMs);
    const inputTokens = scored.reduce(
      (total, result) => total + (result.usage?.inputTokens ?? 0),
      0,
    );
    const outputTokens = scored.reduce(
      (total, result) => total + (result.usage?.outputTokens ?? 0),
      0,
    );
    const changedScores = scored
      .map(changedCorrect)
      .filter((value): value is boolean => value !== null);
    const eventScores = scored
      .map(eventHit)
      .filter((value): value is boolean => value !== null);
    const usageKnown = scored.some(
      (result) =>
        result.usage?.inputTokens != null ||
        result.usage?.outputTokens != null,
    );
    return {
      providerId: provider.id,
      model: scored[0]?.model ?? provider.model,
      sampleCount: scored.length,
      errorCount: scored.filter((result) => result.error !== undefined).length,
      jsonOkCount: scored.filter((result) => result.jsonOk).length,
      parseOkCount: scored.filter((result) => result.parseOk).length,
      changedScoreCount: changedScores.length,
      changedCorrectCount: changedScores.filter(Boolean).length,
      eventScoreCount: eventScores.length,
      eventHitCount: eventScores.filter(Boolean).length,
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      inputTokens,
      outputTokens,
      estimatedCostUsd: usageKnown
        ? (inputTokens / 1_000_000) * provider.usdPerMillionTokens.input +
          (outputTokens / 1_000_000) * provider.usdPerMillionTokens.output
        : null,
    };
  });
}
