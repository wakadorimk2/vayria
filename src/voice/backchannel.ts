import { apiUrl } from '../runtimeConfig';

export const LISTENING_BACKCHANNEL_TEXT = 'うん';

export async function fetchListeningBackchannel(
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: LISTENING_BACKCHANNEL_TEXT,
      emotion: 'neutral',
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error('傾聴相槌の音声を準備できませんでした。');
  }
  return response.arrayBuffer();
}
