import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayAudio } from '../audio/useAudioLipSync';
import {
  normalizeEmotion,
  type Emotion,
} from '../character/emotion';

type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

interface ChatResponse {
  emotion: unknown;
  text: string;
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
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConversationStatus>('idle');
  const emotionHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearEmotionHold = useCallback(() => {
    if (emotionHoldTimerRef.current) {
      clearTimeout(emotionHoldTimerRef.current);
      emotionHoldTimerRef.current = null;
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      clearEmotionHold();
      setEmotion('neutral');
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
        if (typeof chatPayload.text !== 'string' || !chatPayload.text.trim()) {
          throw new Error('AI の返答形式が正しくありません。');
        }
        const responseEmotion = normalizeEmotion(chatPayload.emotion);
        setReply(chatPayload.text);
        setEmotion(responseEmotion);
        setStatus('synthesizing');

        const ttsResponse = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: chatPayload.text,
            emotion: responseEmotion,
          }),
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
        emotionHoldTimerRef.current = setTimeout(() => {
          emotionHoldTimerRef.current = null;
          setEmotion('neutral');
        }, 800);
      } catch (caughtError) {
        clearEmotionHold();
        setEmotion('neutral');
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : '会話処理に失敗しました。',
        );
        setStatus('error');
      }
    },
    [clearEmotionHold, playAudio],
  );

  useEffect(() => clearEmotionHold, [clearEmotionHold]);

  return {
    emotion,
    error,
    isBusy: ['thinking', 'synthesizing', 'speaking'].includes(status),
    reply,
    send,
    status,
  };
}
