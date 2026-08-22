export interface ListeningBackchannelProfile {
  readonly rateScale: number;
  readonly intonationScale: number;
}

export const LISTENING_BACKCHANNEL_PROFILES = [
  { rateScale: 0.92, intonationScale: 0.82 },
  { rateScale: 0.96, intonationScale: 0.96 },
  { rateScale: 1.0, intonationScale: 1.0 },
  { rateScale: 1.04, intonationScale: 1.08 },
  { rateScale: 1.08, intonationScale: 0.9 },
  { rateScale: 0.94, intonationScale: 1.16 },
] as const satisfies readonly ListeningBackchannelProfile[];

export const LISTENING_BACKCHANNEL_PROBABILITY = 0.35;
export const LISTENING_BACKCHANNEL_MIN_DELAY_MS = 1_200;
export const LISTENING_BACKCHANNEL_MAX_DELAY_MS = 1_800;

export type RandomSource = () => number;

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 0.999_999_999;
  return value;
}

export function scheduleListeningBackchannel(
  random: RandomSource = Math.random,
): number | null {
  if (normalizeRandom(random()) >= LISTENING_BACKCHANNEL_PROBABILITY) {
    return null;
  }

  const delayRange =
    LISTENING_BACKCHANNEL_MAX_DELAY_MS -
    LISTENING_BACKCHANNEL_MIN_DELAY_MS +
    1;
  return (
    LISTENING_BACKCHANNEL_MIN_DELAY_MS +
    Math.floor(normalizeRandom(random()) * delayRange)
  );
}

export function selectListeningBackchannelIndex(
  count: number,
  previousIndex: number | null,
  random: RandomSource = Math.random,
): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;

  const candidates = Array.from({ length: count }, (_, index) => index).filter(
    (index) => index !== previousIndex,
  );
  const selected = candidates[
    Math.floor(normalizeRandom(random()) * candidates.length)
  ];
  return selected ?? null;
}

export function collectSuccessfulBackchannelAudio(
  results: readonly PromiseSettledResult<ArrayBuffer>[],
): ArrayBuffer[] {
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
}
