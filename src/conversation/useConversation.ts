import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayAudio } from '../audio/useAudioLipSync';
import { normalizeEmotion, type Emotion } from '../character/emotion';

export type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export type ConversationSource = 'manual' | 'autonomous';

interface ChatResponse {
  activatedCards: unknown;
  emotion: unknown;
  text: string;
}

export interface ChatCardContext {
  brainCardIds: string[];
  forcedCardId: string | null;
}

interface ConversationHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationOptions {
  historyLimit?: number;
  isMuted?: boolean;
}

interface ErrorResponse {
  error?: string;
}

const DEFAULT_HISTORY_LIMIT = 6;
const MAX_HISTORY_LIMIT = 10;
const ACTIVE_STATUSES: ConversationStatus[] = [
  'thinking',
  'synthesizing',
  'speaking',
];

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorResponse;
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

function readActivatedCards(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    !value.every((id): id is string => typeof id === 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new Error('AI の発動カード形式が正しくありません。');
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_HISTORY_LIMIT));
}

export function useConversation(
  playAudio: PlayAudio,
  stopAudio: () => void,
  options: ConversationOptions = {},
) {
  const historyLimit = normalizeHistoryLimit(options.historyLimit);
  const isMuted = options.isMuted ?? false;
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [source, setSource] = useState<ConversationSource | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const emotionHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const historyRef = useRef<ConversationHistoryItem[]>([]);
  const isMutedRef = useRef(isMuted);
  const sourceRef = useRef<ConversationSource | null>(null);
  const statusRef = useRef<ConversationStatus>('idle');

  const setConversationState = useCallback(
    (nextStatus: ConversationStatus, nextSource: ConversationSource | null) => {
      statusRef.current = nextStatus;
      sourceRef.current = nextSource;
      setStatus(nextStatus);
      setSource(nextSource);
    },
    [],
  );

  const clearEmotionHold = useCallback(() => {
    if (emotionHoldTimerRef.current) {
      clearTimeout(emotionHoldTimerRef.current);
      emotionHoldTimerRef.current = null;
    }
  }, []);

  const abortFetch = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const invalidateCurrentTurn = useCallback(
    (stopPlayback: boolean) => {
      generationRef.current += 1;
      abortFetch();
      if (stopPlayback) stopAudio();
    },
    [abortFetch, stopAudio],
  );

  const cancelAutonomous = useCallback(() => {
    if (sourceRef.current !== 'autonomous') return;
    invalidateCurrentTurn(true);
    clearEmotionHold();
    setEmotion('neutral');
    setError('');
    setConversationState('idle', null);
  }, [clearEmotionHold, invalidateCurrentTurn, setConversationState]);

  const appendHistory = useCallback(
    (items: ConversationHistoryItem[]) => {
      historyRef.current = [...historyRef.current, ...items].slice(-historyLimit);
    },
    [historyLimit],
  );

  const processTurn = useCallback(
    async (
      turnSource: ConversationSource,
      message: string | null,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
    ): Promise<boolean> => {
      if (turnSource === 'autonomous') {
        if (
          isMutedRef.current ||
          ACTIVE_STATUSES.includes(statusRef.current)
        ) {
          return false;
        }
      } else {
        if (sourceRef.current === 'manual' && statusRef.current !== 'idle') {
          return false;
        }
        if (sourceRef.current === 'autonomous') invalidateCurrentTurn(true);
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      clearEmotionHold();
      setEmotion('neutral');
      setError('');
      setConversationState('thinking', turnSource);
      let requestController: AbortController | null = null;

      try {
        const chatController = new AbortController();
        requestController = chatController;
        abortControllerRef.current = chatController;
        const chatResponse = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: turnSource,
            ...(message === null ? {} : { message }),
            history: historyRef.current,
            ...cardContext,
          }),
          signal: chatController.signal,
        });
        if (generation !== generationRef.current) return false;
        if (!chatResponse.ok) {
          throw new Error(
            await readError(chatResponse, 'AI の返答を取得できませんでした。'),
          );
        }

        const chatPayload = (await chatResponse.json()) as ChatResponse;
        if (generation !== generationRef.current) return false;
        if (abortControllerRef.current === chatController) {
          abortControllerRef.current = null;
        }
        if (typeof chatPayload.text !== 'string' || !chatPayload.text.trim()) {
          throw new Error('AI の返答形式が正しくありません。');
        }
        const activatedCards = readActivatedCards(chatPayload.activatedCards);
        const brainCardIds = new Set(cardContext.brainCardIds);
        if (activatedCards.some((id) => !brainCardIds.has(id))) {
          throw new Error('AI が脳内にないカードを発動しました。');
        }
        if (
          cardContext.forcedCardId &&
          !activatedCards.includes(cardContext.forcedCardId)
        ) {
          throw new Error('AI が交換したカードを発動しませんでした。');
        }

        const responseEmotion = normalizeEmotion(chatPayload.emotion);
        setReply(chatPayload.text);
        setEmotion(responseEmotion);
        onReplyAccepted(activatedCards);

        if (turnSource === 'manual') {
          appendHistory([
            { role: 'user', content: message ?? '' },
            { role: 'assistant', content: chatPayload.text },
          ]);
        }

        if (isMutedRef.current) {
          setConversationState('idle', null);
          return true;
        }

        setConversationState('synthesizing', turnSource);
        const ttsController = new AbortController();
        requestController = ttsController;
        abortControllerRef.current = ttsController;
        const ttsResponse = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: chatPayload.text,
            emotion: responseEmotion,
          }),
          signal: ttsController.signal,
        });
        if (generation !== generationRef.current) return false;
        if (!ttsResponse.ok) {
          throw new Error(
            await readError(ttsResponse, '返答音声を生成できませんでした。'),
          );
        }

        const audioData = await ttsResponse.arrayBuffer();
        if (abortControllerRef.current === ttsController) {
          abortControllerRef.current = null;
        }
        if (generation !== generationRef.current || isMutedRef.current) {
          if (generation === generationRef.current) {
            setConversationState('idle', null);
          }
          return turnSource === 'manual';
        }

        await playAudio(audioData, {
          onStart: () => {
            if (generation === generationRef.current) {
              setConversationState('speaking', turnSource);
            }
          },
        });
        if (generation !== generationRef.current) return false;

        if (turnSource === 'autonomous') {
          appendHistory([{ role: 'assistant', content: chatPayload.text }]);
        }
        setConversationState('idle', null);
        emotionHoldTimerRef.current = setTimeout(() => {
          emotionHoldTimerRef.current = null;
          if (generation === generationRef.current) setEmotion('neutral');
        }, 800);
        return true;
      } catch (caughtError) {
        if (abortControllerRef.current === requestController) {
          abortControllerRef.current = null;
        }
        if (generation !== generationRef.current) return false;
        if (isAbortError(caughtError)) {
          setConversationState('idle', null);
          return turnSource === 'manual' && isMutedRef.current;
        }

        clearEmotionHold();
        setEmotion('neutral');
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : '会話処理に失敗しました。',
        );
        setConversationState('error', null);
        return false;
      }
    },
    [
      appendHistory,
      clearEmotionHold,
      invalidateCurrentTurn,
      playAudio,
      setConversationState,
    ],
  );

  const sendManual = useCallback(
    (
      message: string,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
    ) => processTurn('manual', message, cardContext, onReplyAccepted),
    [processTurn],
  );

  const sendAutonomous = useCallback(
    (
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
    ) => processTurn('autonomous', null, cardContext, onReplyAccepted),
    [processTurn],
  );

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (!isMuted) return;

    stopAudio();
    if (sourceRef.current === 'autonomous') {
      cancelAutonomous();
      return;
    }

    if (
      sourceRef.current === 'manual' &&
      ['synthesizing', 'speaking'].includes(statusRef.current)
    ) {
      if (statusRef.current === 'synthesizing') abortFetch();
      setConversationState('idle', null);
    }
  }, [abortFetch, cancelAutonomous, isMuted, setConversationState, stopAudio]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortFetch();
      clearEmotionHold();
    };
  }, [abortFetch, clearEmotionHold]);

  const isBusy = ACTIVE_STATUSES.includes(status);

  return {
    cancelAutonomous,
    emotion,
    error,
    isBusy,
    isManualBusy: isBusy && source === 'manual',
    reply,
    sendAutonomous,
    sendManual,
    source,
    status,
  };
}
