import { useCallback, useState } from 'react';
import type { PlayAudio } from '../audio/useAudioLipSync';

type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

interface ChatResponse {
  reply: string;
}

interface ErrorResponse {
  error?: string;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorResponse;
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export function useConversation(playAudio: PlayAudio) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConversationStatus>('idle');

  const send = useCallback(
    async (message: string) => {
      setError('');
      setStatus('thinking');

      try {
        const chatResponse = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (!chatResponse.ok) {
          throw new Error(
            await readError(chatResponse, 'AI の返答を取得できませんでした。'),
          );
        }

        const chatPayload = (await chatResponse.json()) as ChatResponse;
        setReply(chatPayload.reply);
        setStatus('synthesizing');

        const ttsResponse = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: chatPayload.reply }),
        });
        if (!ttsResponse.ok) {
          throw new Error(
            await readError(ttsResponse, '返答音声を生成できませんでした。'),
          );
        }

        await playAudio(await ttsResponse.arrayBuffer(), {
          onStart: () => setStatus('speaking'),
        });
        setStatus('idle');
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : '会話処理に失敗しました。',
        );
        setStatus('error');
      }
    },
    [playAudio],
  );

  return {
    error,
    isBusy: ['thinking', 'synthesizing', 'speaking'].includes(status),
    reply,
    send,
    status,
  };
}
