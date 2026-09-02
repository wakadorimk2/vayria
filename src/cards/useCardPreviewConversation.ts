import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeEmotion, type Emotion } from '../character/emotion';
import { apiUrl } from '../runtimeConfig';
import { readAudioPlaybackSource } from '../audio/audioPlaybackSource.js';
import type { PerformancePlayback } from '../performer/performancePlayback';
import type {
  PerformancePlan,
  PerformanceResult,
} from '../performer/types';

export type CardPreviewStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

interface CardPreviewResponse {
  text: string;
  emotion: Emotion;
}

interface CardPreviewConversationOptions {
  onPerformanceCue?: (
    planId: string,
    cue: { emotion: Emotion; intensity: number },
  ) => void;
  onPerformancePlan?: (plan: PerformancePlan) => void;
  onPerformanceResult?: (result: PerformanceResult) => void;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : fallback;
  } catch {
    return fallback;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readCardPreviewResponse(
  response: Response,
): Promise<CardPreviewResponse> {
  if (!response.ok) {
    throw new Error(
      await readError(response, 'カード実演の発話を取得できませんでした。'),
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (
    typeof payload.text !== 'string' ||
    !payload.text.trim() ||
    typeof payload.emotion !== 'string'
  ) {
    throw new Error('カード実演の応答形式が正しくありません。');
  }

  return {
    text: payload.text.trim(),
    emotion: normalizeEmotion(payload.emotion),
  };
}

export function useCardPreviewConversation(
  playback: PerformancePlayback,
  options: CardPreviewConversationOptions = {},
) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<CardPreviewStatus>('idle');
  const [isBusy, setIsBusy] = useState(false);
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activePlanRef = useRef<PerformancePlan | null>(null);
  const onPerformanceCueRef = useRef(options.onPerformanceCue);
  const onPerformancePlanRef = useRef(options.onPerformancePlan);
  const onPerformanceResultRef = useRef(options.onPerformanceResult);

  useEffect(() => {
    onPerformanceCueRef.current = options.onPerformanceCue;
    onPerformancePlanRef.current = options.onPerformancePlan;
    onPerformanceResultRef.current = options.onPerformanceResult;
  }, [
    options.onPerformanceCue,
    options.onPerformancePlan,
    options.onPerformanceResult,
  ]);

  const emitResult = useCallback(
    (
      plan: PerformancePlan,
      outcome: PerformanceResult['outcome'],
      extras: Omit<
        Partial<PerformanceResult>,
        'planId' | 'completedAt' | 'outcome' | 'trigger' | 'intent'
      > = {},
    ) => {
      if (activePlanRef.current?.planId !== plan.planId) return;
      activePlanRef.current = null;
      onPerformanceResultRef.current?.({
        planId: plan.planId,
        completedAt: Date.now(),
        outcome,
        trigger: plan.trigger,
        intent: plan.intent,
        ...extras,
      });
    },
    [],
  );

  const cancelPreview = useCallback(() => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    playback.stop();
    const activePlan = activePlanRef.current;
    if (activePlan) emitResult(activePlan, 'cancelled');
    setReply('');
    setError('');
    setIsBusy(false);
    setStatus('idle');
  }, [emitResult, playback]);

  const startPreview = useCallback(
    async (cardId: string, plan: PerformancePlan) => {
      cancelPreview();
      const generation = generationRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      activePlanRef.current = plan;
      onPerformancePlanRef.current?.(plan);
      setReply('');
      setError('');
      setIsBusy(true);
      setStatus('thinking');

      let speechStartedAt: number | undefined;
      try {
        const leadBeforeSpeechMs = plan.preReaction?.leadBeforeSpeechMs ?? 0;
        if (leadBeforeSpeechMs > 0) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, leadBeforeSpeechMs),
          );
        }
        if (generation !== generationRef.current) return;

        const response = await fetch(apiUrl('/api/card-preview'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Performer-Turn-Id': plan.planId,
          },
          body: JSON.stringify({
            cardId,
            performanceContext: plan.speech?.llmContext ?? {
              callbackTendency: 0,
              fragmentation: 0,
              semanticBiases: [],
            },
          }),
          signal: controller.signal,
        });
        if (generation !== generationRef.current) return;

        const preview = await readCardPreviewResponse(response);
        if (generation !== generationRef.current) return;
        setReply(preview.text);
        onPerformanceCueRef.current?.(plan.planId, {
          emotion: preview.emotion,
          intensity: preview.emotion === 'neutral' ? 0.25 : 0.7,
        });

        const speechDelayMs = plan.speech?.delayMs ?? 0;
        if (speechDelayMs > 0) {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, speechDelayMs),
          );
        }
        if (generation !== generationRef.current) return;

        setStatus('synthesizing');
        const ttsResponse = await fetch(apiUrl('/api/tts'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Performer-Turn-Id': plan.planId,
          },
          body: JSON.stringify({
            text: preview.text,
            emotion: preview.emotion,
            ttsProfile: plan.ttsProfile,
          }),
          signal: controller.signal,
        });
        if (generation !== generationRef.current) return;
        if (!ttsResponse.ok) {
          throw new Error(
            await readError(ttsResponse, 'カード実演の音声を生成できませんでした。'),
          );
        }

        const audioSource = await readAudioPlaybackSource(ttsResponse);
        if (generation !== generationRef.current) return;
        const playbackResult = await playback.play(plan, audioSource, {
          onSpeechStart: (startedAt) => {
            speechStartedAt = startedAt;
            if (generation === generationRef.current) setStatus('speaking');
          },
        });
        if (generation !== generationRef.current) return;
        if (!playbackResult) return;

        setIsBusy(false);
        setStatus('idle');
        emitResult(plan, 'completed', {
          spokenText: preview.text,
          emotionCue: {
            emotion: preview.emotion,
            intensity: preview.emotion === 'neutral' ? 0.25 : 0.7,
          },
          speechStartedAt,
          speechEndedAt: playbackResult.speechEndedAt,
        });
      } catch (caughtError) {
        if (generation !== generationRef.current || isAbortError(caughtError)) {
          return;
        }
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'カード実演に失敗しました。',
        );
        setIsBusy(false);
        setStatus('error');
        emitResult(plan, 'failed');
      } finally {
        if (generation === generationRef.current) {
          abortControllerRef.current = null;
        }
      }
    },
    [cancelPreview, emitResult, playback],
  );

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      playback.stop();
      activePlanRef.current = null;
    };
  }, [playback]);

  return {
    cancelPreview,
    error,
    isBusy,
    reply,
    startPreview,
    status,
  };
}
