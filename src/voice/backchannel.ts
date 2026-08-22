import { apiUrl } from '../runtimeConfig';
import {
  collectSuccessfulBackchannelAudio,
  LISTENING_BACKCHANNEL_PROFILES,
  type ListeningBackchannelProfile,
} from './backchannelPolicy';

export const LISTENING_BACKCHANNEL_TEXT = 'うん';

export async function fetchListeningBackchannel(
  profile: ListeningBackchannelProfile = LISTENING_BACKCHANNEL_PROFILES[0],
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: LISTENING_BACKCHANNEL_TEXT,
      emotion: 'neutral',
      ttsProfile: profile,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error('傾聴相槌の音声を準備できませんでした。');
  }
  return response.arrayBuffer();
}

export async function fetchListeningBackchannels(
  signal?: AbortSignal,
): Promise<ArrayBuffer[]> {
  const results = await Promise.allSettled(
    LISTENING_BACKCHANNEL_PROFILES.map((profile) =>
      fetchListeningBackchannel(profile, signal),
    ),
  );
  return collectSuccessfulBackchannelAudio(results);
}
