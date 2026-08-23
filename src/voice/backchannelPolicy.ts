import type { VoiceBackchannelCue } from './voiceInteraction.js';

export interface ListeningBackchannelProfile {
  readonly rateScale: number;
  readonly intonationScale: number;
}

export const LISTENING_BACKCHANNEL_PROFILES = [
  { rateScale: 0.92, intonationScale: 0.82 },
  { rateScale: 1.0, intonationScale: 1.0 },
  { rateScale: 0.94, intonationScale: 1.16 },
] as const satisfies readonly ListeningBackchannelProfile[];

export interface ListeningBackchannelAudio {
  cue: Exclude<VoiceBackchannelCue, 'none'>;
  variantIndex: number;
  audioData: ArrayBuffer;
}

export type RandomSource = () => number;

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 0.999_999_999;
  return value;
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
  results: readonly PromiseSettledResult<ListeningBackchannelAudio>[],
): ListeningBackchannelAudio[] {
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
}
