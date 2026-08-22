import { apiUrl } from '../runtimeConfig';
import {
  collectSuccessfulBackchannelAudio,
  LISTENING_BACKCHANNEL_PROFILES,
  type ListeningBackchannelAudio,
  type ListeningBackchannelProfile,
} from './backchannelPolicy';
import type { VoiceBackchannelCue } from './voiceInteraction';

export const LISTENING_BACKCHANNEL_TEXT = 'うん';
export const LISTENING_BACKCHANNEL_TEXT_BY_CUE = {
  un: 'うん',
  uun: 'うーん',
} as const satisfies Record<Exclude<VoiceBackchannelCue, 'none'>, string>;

export type ListeningBackchannelCue = Exclude<VoiceBackchannelCue, 'none'>;

export async function fetchListeningBackchannel(
  cue: ListeningBackchannelCue = 'un',
  profile: ListeningBackchannelProfile = LISTENING_BACKCHANNEL_PROFILES[0],
  variantIndex = 0,
  signal?: AbortSignal,
): Promise<ListeningBackchannelAudio> {
  const response = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: LISTENING_BACKCHANNEL_TEXT_BY_CUE[cue],
      emotion: 'neutral',
      ttsProfile: profile,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error('傾聴相槌の音声を準備できませんでした。');
  }
  return {
    cue,
    variantIndex,
    audioData: await response.arrayBuffer(),
  };
}

export async function fetchListeningBackchannels(
  signal?: AbortSignal,
): Promise<ListeningBackchannelAudio[]> {
  const cues: ListeningBackchannelCue[] = ['un', 'uun'];
  const results = await Promise.allSettled(
    cues.flatMap((cue) =>
      LISTENING_BACKCHANNEL_PROFILES.map((profile, variantIndex) =>
        fetchListeningBackchannel(cue, profile, variantIndex, signal),
      ),
    ),
  );
  return collectSuccessfulBackchannelAudio(results);
}
