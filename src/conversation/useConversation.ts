import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeEmotion, type Emotion } from '../character/emotion';
import { createConversationEventEmitter } from './conversationEvents';
import { apiUrl } from '../runtimeConfig';
import type { PerformancePlayback } from '../performer/performancePlayback';
import type {
  ConversationActionDecision,
  PerformancePlan,
  PerformanceResult,
} from '../performer/types';
import { isConversationActionDecision } from '../performer/types';

export type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export type ConversationSource = 'manual' | 'voice' | 'autonomous';

export const AUTONOMOUS_ACTIONS = [
  'continue',
  'new_topic',
  'silence',
] as const;

export type AutonomousAction = (typeof AUTONOMOUS_ACTIONS)[number];

export interface AutonomousContext {
  topic: string | null;
  topicTurns: number;
}

export interface AutonomousDecision {
  action: AutonomousAction;
  topic: string;
}

interface ChatResponse {
  action?: unknown;
  activatedCards: unknown;
  backchannelCue?: unknown;
  emotion: unknown;
  text: string;
  topic?: unknown;
  interactionAction?: unknown;
}

export interface ChatCardContext {
  brainCardIds: string[];
  forcedCardId: string | null;
}

interface ConversationHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface PerformanceContextPayload {
  callbackTendency: number;
  fragmentation: number;
  semanticBiases: string[];
}

interface ConversationOptions {
  historyLimit?: number;
  isMuted?: boolean;
  isExhibitionMode?: boolean;
  onPerformanceCue?: (
    planId: string,
    cue: { emotion: Emotion; intensity: number },
  ) => void;
  onPerformancePlan?: (plan: PerformancePlan) => void;
  onPerformanceResult?: (result: PerformanceResult) => void;
  onInteractionAction?: (decision: ConversationActionDecision) => void;
}

interface ErrorResponse {
  error?: string;
}

interface ProcessTurnResult {
  completed: boolean;
  decision: AutonomousDecision | null;
}

const DEFAULT_HISTORY_LIMIT = 6;
const MAX_HISTORY_LIMIT = 10;
const SUBTITLE_HOLD_MS = 1_500;
const ACTIVE_STATUSES: ConversationStatus[] = [
  'thinking',
  'synthesizing',
  'speaking',
];

const INTERACTIVE_SOURCES: ConversationSource[] = ['manual', 'voice'];

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorResponse;
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

function readActivatedCards(value: unknown, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length < 1) ||
    value.length > 3 ||
    !value.every((id): id is string => typeof id === 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new Error('AI の発動カード形式が正しくありません。');
  }
  return value;
}

function isAutonomousAction(value: unknown): value is AutonomousAction {
  return (
    typeof value === 'string' &&
    (AUTONOMOUS_ACTIONS as readonly string[]).includes(value)
  );
}

function readAutonomousDecision(
  action: unknown,
  topic: unknown,
  forcedCardId: string | null,
): AutonomousDecision {
  if (!isAutonomousAction(action)) {
    throw new Error('AI の自律発話アクション形式が正しくありません。');
  }
  if (typeof topic !== 'string') {
    throw new Error('AI の自律発話トピック形式が正しくありません。');
  }

  const normalizedTopic = topic.trim();
  if (normalizedTopic.length > 120) {
    throw new Error('AI の自律発話トピックが長すぎます。');
  }
  if (action !== 'silence' && !normalizedTopic) {
    throw new Error('発話する自律応答にはトピックが必要です。');
  }
  if (action === 'silence' && forcedCardId) {
    throw new Error('交換カードがある自律応答は沈黙できません。');
  }

  return { action, topic: normalizedTopic };
}

function readConversationActionDecision(
  action: unknown,
  backchannelCue: unknown,
): ConversationActionDecision {
  const decision = { action, backchannelCue };
  if (
    !isConversationActionDecision(decision) ||
    decision.action === 'wait'
  ) {
    throw new Error('AI の会話行動アクション形式が正しくありません。');
  }
  return decision;
}

function createInteractionReactionPlan(plan: PerformancePlan): PerformancePlan {
  return {
    ...plan,
    intent: 'react_nonverbally',
    motion: undefined,
    speech: undefined,
    ttsProfile: undefined,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_HISTORY_LIMIT));
}

function waitMilliseconds(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function useConversation(
  playback: PerformancePlayback,
  options: ConversationOptions = {},
) {
  const historyLimit = normalizeHistoryLimit(options.historyLimit);
  const isMuted = options.isMuted ?? false;
  const isExhibitionMode = options.isExhibitionMode ?? false;
  const [reply, setReply] = useState('');
  const [isSubtitleVisible, setIsSubtitleVisible] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [source, setSource] = useState<ConversationSource | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const subtitleClearTimerRef = useRef<number | null>(null);
  const historyRef = useRef<ConversationHistoryItem[]>([]);
  const lastAutonomousReplyRef = useRef<string | null>(null);
  const isMutedRef = useRef(isMuted);
  const sourceRef = useRef<ConversationSource | null>(null);
  const statusRef = useRef<ConversationStatus>('idle');
  const activePlanRef = useRef<PerformancePlan | null>(null);
  const activeTurnControlRef = useRef<{
    interrupt: (reason: string) => void;
  } | null>(null);
  const onPerformanceCueRef = useRef(options.onPerformanceCue);
  const onPerformancePlanRef = useRef(options.onPerformancePlan);
  const onPerformanceResultRef = useRef(options.onPerformanceResult);
  const onInteractionActionRef = useRef(options.onInteractionAction);

  useEffect(() => {
    onPerformanceCueRef.current = options.onPerformanceCue;
    onPerformancePlanRef.current = options.onPerformancePlan;
    onPerformanceResultRef.current = options.onPerformanceResult;
    onInteractionActionRef.current = options.onInteractionAction;
  }, [
    options.onPerformanceCue,
    options.onPerformancePlan,
    options.onPerformanceResult,
    options.onInteractionAction,
  ]);

  const setConversationState = useCallback(
    (nextStatus: ConversationStatus, nextSource: ConversationSource | null) => {
      statusRef.current = nextStatus;
      sourceRef.current = nextSource;
      setStatus(nextStatus);
      setSource(nextSource);
    },
    [],
  );

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

  const finishActivePlanAsCancelled = useCallback(() => {
    const plan = activePlanRef.current;
    if (!plan) return;
    emitResult(plan, 'cancelled');
  }, [emitResult]);

  const abortFetch = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const clearSubtitleTimer = useCallback(() => {
    if (subtitleClearTimerRef.current === null) return;
    window.clearTimeout(subtitleClearTimerRef.current);
    subtitleClearTimerRef.current = null;
  }, []);

  const clearSubtitle = useCallback(() => {
    clearSubtitleTimer();
    setIsSubtitleVisible(false);
  }, [clearSubtitleTimer]);

  const scheduleSubtitleClear = useCallback(
    (generation: number) => {
      if (!isExhibitionMode) return;
      clearSubtitleTimer();
      const timerId = window.setTimeout(() => {
        if (subtitleClearTimerRef.current !== timerId) return;
        subtitleClearTimerRef.current = null;
        if (generation !== generationRef.current) return;
        setIsSubtitleVisible(false);
      }, SUBTITLE_HOLD_MS);
      subtitleClearTimerRef.current = timerId;
    },
    [clearSubtitleTimer, isExhibitionMode],
  );

  const invalidateCurrentTurn = useCallback(
    (stopPlayback: boolean) => {
      generationRef.current += 1;
      abortFetch();
      if (stopPlayback) playback.stop();
    },
    [abortFetch, playback],
  );

  const interruptCurrentTurn = useCallback(
    (reason = 'interrupted') => {
      activeTurnControlRef.current?.interrupt(reason);
      const plan = activePlanRef.current;
      if (plan) emitResult(plan, 'interrupted');
      invalidateCurrentTurn(true);
      clearSubtitle();
      setError('');
      setConversationState('idle', null);
    },
    [clearSubtitle, emitResult, invalidateCurrentTurn, setConversationState],
  );

  const cancelAutonomous = useCallback(() => {
    if (sourceRef.current !== 'autonomous') return;
    finishActivePlanAsCancelled();
    invalidateCurrentTurn(true);
    clearSubtitle();
    setError('');
    setConversationState('idle', null);
  }, [
    clearSubtitle,
    finishActivePlanAsCancelled,
    invalidateCurrentTurn,
    setConversationState,
  ]);

  const resetConversation = useCallback(() => {
    finishActivePlanAsCancelled();
    invalidateCurrentTurn(true);
    historyRef.current = [];
    lastAutonomousReplyRef.current = null;
    clearSubtitle();
    setReply('');
    setError('');
    setConversationState('idle', null);
  }, [
    clearSubtitle,
    finishActivePlanAsCancelled,
    invalidateCurrentTurn,
    setConversationState,
  ]);

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
      autonomousContext: AutonomousContext | null,
      plan: PerformancePlan,
    ): Promise<ProcessTurnResult> => {
      const eventEmitter = createConversationEventEmitter(turnSource);
      let terminalEventEmitted = false;
      const emitTerminalEvent = (
        event: 'turn_completed' | 'turn_aborted' | 'turn_failed',
        details: Parameters<typeof eventEmitter.emit>[1] = {},
      ) => {
        if (terminalEventEmitted) return;
        terminalEventEmitted = true;
        eventEmitter.emit(event, details);
      };

      eventEmitter.emit('input_received');

      if (turnSource === 'autonomous') {
        if (
          isMutedRef.current ||
          ACTIVE_STATUSES.includes(statusRef.current)
        ) {
          emitTerminalEvent('turn_aborted', {
            reason: isMutedRef.current ? 'muted' : 'busy',
          });
          return { completed: false, decision: null };
        }
      } else {
        if (sourceRef.current === 'manual' && statusRef.current !== 'idle') {
          emitTerminalEvent('turn_aborted', { reason: 'busy' });
          return { completed: false, decision: null };
        }
        if (sourceRef.current === 'autonomous') {
          finishActivePlanAsCancelled();
          invalidateCurrentTurn(true);
        }
      }

      clearSubtitle();

      const pendingPlan =
        turnSource === 'voice' ? createInteractionReactionPlan(plan) : plan;
      let executionPlan = pendingPlan;
      activePlanRef.current = plan;
      onPerformancePlanRef.current?.(pendingPlan);
      playback.prepare(pendingPlan);
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setError('');
      setConversationState('thinking', turnSource);
      const localInteractionDecision =
        INTERACTIVE_SOURCES.includes(turnSource) &&
        plan.actionDecision &&
        plan.actionDecision.action !== 'take_floor'
          ? plan.actionDecision
          : null;
      if (localInteractionDecision) {
        const reactionPlan = createInteractionReactionPlan(plan);
        activePlanRef.current = plan;
        onPerformancePlanRef.current?.(reactionPlan);
        playback.prepare(reactionPlan);
        appendHistory([{ role: 'user', content: message ?? '' }]);
        setConversationState('idle', null);
        emitResult(reactionPlan, 'completed', {
          interactionAction: localInteractionDecision.action,
          emotionCue: { emotion: 'neutral', intensity: 0 },
        });
        onInteractionActionRef.current?.(localInteractionDecision);
        emitTerminalEvent('turn_completed', {
          reason: localInteractionDecision.action,
          interactionAction: localInteractionDecision.action,
        });
        return { completed: true, decision: null };
      }
      const turnControl = {
        interrupt: (reason: string) => {
          emitTerminalEvent('turn_aborted', { reason });
        },
      };
      activeTurnControlRef.current = turnControl;
      let requestController: AbortController | null = null;
      let currentPhase: 'llm' | 'tts' = 'llm';
      let responseEmotion: Emotion | undefined;
      let motionStartedAt: number | undefined;
      let speechStartedAt: number | undefined;
      let interactionDecision: ConversationActionDecision | null = null;

      try {
        if (turnSource !== 'voice') {
          await waitMilliseconds(plan.preReaction?.leadBeforeSpeechMs ?? 0);
        }
        if (generation !== generationRef.current) {
          emitResult(pendingPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded' });
          return { completed: false, decision: null };
        }

        const chatController = new AbortController();
        requestController = chatController;
        abortControllerRef.current = chatController;
        const llmStartedAt = performance.now();
        eventEmitter.emit('llm_start', { phase: 'llm' });
        const chatResponse = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Performer-Turn-Id': eventEmitter.turnId,
            ...(eventEmitter.runId
              ? { 'X-Performer-Run-Id': eventEmitter.runId }
              : {}),
          },
          body: JSON.stringify({
            mode:
              turnSource === 'autonomous'
                ? 'autonomous'
                : turnSource === 'voice'
                  ? 'voice'
                  : 'manual',
            ...(message === null ? {} : { message }),
            history: historyRef.current,
            ...cardContext,
            performanceContext: plan.speech?.llmContext ?? {
              callbackTendency: 0,
              fragmentation: 0,
              semanticBiases: [],
            },
            ...(turnSource === 'autonomous'
              ? {
                  topic: autonomousContext?.topic ?? null,
                  topicTurns: autonomousContext?.topicTurns ?? 0,
                  previousAutonomousReply: lastAutonomousReplyRef.current,
                }
              : {}),
          }),
          signal: chatController.signal,
        });
        if (!chatResponse.ok) {
          throw new Error(
            await readError(chatResponse, 'AI の返答を取得できませんでした。'),
          );
        }

        const chatPayload = (await chatResponse.json()) as ChatResponse;
        eventEmitter.emit('llm_done', {
          durationMs: performance.now() - llmStartedAt,
          phase: 'llm',
        });
        if (generation !== generationRef.current) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded', phase: 'llm' });
          return { completed: false, decision: null };
        }
        if (abortControllerRef.current === chatController) {
          abortControllerRef.current = null;
        }
        if (typeof chatPayload.text !== 'string') {
          throw new Error('AI の返答形式が正しくありません。');
        }
        const responseText = chatPayload.text.trim();
        if (INTERACTIVE_SOURCES.includes(turnSource)) {
          interactionDecision = readConversationActionDecision(
            chatPayload.interactionAction,
            chatPayload.backchannelCue,
          );
        }
        const autonomousDecision =
          turnSource === 'autonomous'
            ? readAutonomousDecision(
                chatPayload.action,
                chatPayload.topic,
                cardContext.forcedCardId,
              )
            : null;
        if (
          (INTERACTIVE_SOURCES.includes(turnSource) &&
            interactionDecision?.action === 'take_floor' &&
            !responseText) ||
          (interactionDecision !== null &&
            interactionDecision.action !== 'take_floor' &&
            responseText) ||
          (autonomousDecision?.action !== 'silence' &&
            autonomousDecision !== null &&
            !responseText) ||
          (autonomousDecision?.action === 'silence' && responseText)
        ) {
          throw new Error('AI の返答形式が正しくありません。');
        }
        const activatedCards = readActivatedCards(
          chatPayload.activatedCards,
          autonomousDecision !== null || interactionDecision !== null,
        );
        if (
          interactionDecision !== null &&
          interactionDecision.action !== 'take_floor' &&
          activatedCards.length
        ) {
          throw new Error('非発話反応はカードを発動できません。');
        }
        if (autonomousDecision?.action === 'silence' && activatedCards.length) {
          throw new Error('沈黙する自律応答はカードを発動できません。');
        }
        const brainCardIds = new Set(cardContext.brainCardIds);
        if (activatedCards.some((id) => !brainCardIds.has(id))) {
          throw new Error('AI が脳内にないカードを発動しました。');
        }
        if (
          cardContext.forcedCardId &&
          (interactionDecision === null ||
            interactionDecision.action === 'take_floor') &&
          !activatedCards.includes(cardContext.forcedCardId)
        ) {
          throw new Error('AI が交換したカードを発動しませんでした。');
        }

        responseEmotion = normalizeEmotion(chatPayload.emotion);
        if (
          interactionDecision &&
          interactionDecision.action !== 'take_floor'
        ) {
          const reactionPlan = createInteractionReactionPlan(plan);
          activePlanRef.current = plan;
          onPerformancePlanRef.current?.(reactionPlan);
          playback.prepare(reactionPlan);
          appendHistory([{ role: 'user', content: message ?? '' }]);
          setConversationState('idle', null);
          emitResult(reactionPlan, 'completed', {
            interactionAction: interactionDecision.action,
            emotionCue: { emotion: 'neutral', intensity: 0 },
          });
          onInteractionActionRef.current?.(interactionDecision);
          emitTerminalEvent('turn_completed', {
            reason: interactionDecision.action,
            interactionAction: interactionDecision.action,
          });
          return { completed: true, decision: null };
        }

        if (turnSource === 'voice') {
          executionPlan = plan;
          activePlanRef.current = plan;
          onPerformancePlanRef.current?.(plan);
          playback.prepare(plan);
        }
        if (autonomousDecision?.action === 'silence') {
          onReplyAccepted([]);
          setConversationState('idle', null);
          emitResult(executionPlan, 'completed', {
            interactionAction: 'silence',
            emotionCue: { emotion: responseEmotion, intensity: 0 },
          });
          emitTerminalEvent('turn_completed', {
            reason: 'silence',
            interactionAction: 'silence',
          });
          return { completed: true, decision: autonomousDecision };
        }

        setReply(responseText);
        if (isExhibitionMode) {
          clearSubtitleTimer();
          setIsSubtitleVisible(true);
        }
        onPerformanceCueRef.current?.(executionPlan.planId, {
          emotion: responseEmotion,
          intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
        });
        onReplyAccepted(activatedCards);

        if (INTERACTIVE_SOURCES.includes(turnSource)) {
          appendHistory([
            { role: 'user', content: message ?? '' },
            { role: 'assistant', content: responseText },
          ]);
        }

        if (isMutedRef.current) {
          clearSubtitle();
          setConversationState('idle', null);
          emitResult(executionPlan, 'cancelled', {
            emotionCue: {
              emotion: responseEmotion,
              intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
            },
          });
          emitTerminalEvent('turn_aborted', {
            reason: 'muted',
            phase: currentPhase,
          });
          return {
            completed: INTERACTIVE_SOURCES.includes(turnSource),
            decision: null,
          };
        }

        setConversationState('synthesizing', turnSource);
        currentPhase = 'tts';
        await waitMilliseconds(plan.speech?.delayMs ?? 0);
        if (generation !== generationRef.current) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', {
            reason: 'superseded',
            phase: currentPhase,
          });
          return { completed: false, decision: null };
        }

        const ttsController = new AbortController();
        requestController = ttsController;
        abortControllerRef.current = ttsController;
        const ttsStartedAt = performance.now();
        eventEmitter.emit('tts_start', { phase: 'tts' });
        const ttsResponse = await fetch(apiUrl('/api/tts'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Performer-Turn-Id': eventEmitter.turnId,
            ...(eventEmitter.runId
              ? { 'X-Performer-Run-Id': eventEmitter.runId }
              : {}),
          },
          body: JSON.stringify({
            text: responseText,
            emotion: responseEmotion,
            ttsProfile: plan.ttsProfile,
          }),
          signal: ttsController.signal,
        });
        if (generation !== generationRef.current) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded', phase: 'tts' });
          return { completed: false, decision: null };
        }
        if (!ttsResponse.ok) {
          throw new Error(
            await readError(ttsResponse, '返答音声を生成できませんでした。'),
          );
        }

        const audioData = await ttsResponse.arrayBuffer();
        eventEmitter.emit('tts_ready', {
          durationMs: performance.now() - ttsStartedAt,
          phase: 'tts',
        });
        if (abortControllerRef.current === ttsController) {
          abortControllerRef.current = null;
        }
        if (generation !== generationRef.current || isMutedRef.current) {
          if (generation === generationRef.current) {
            setConversationState('idle', null);
            emitResult(executionPlan, 'cancelled', {
              emotionCue: {
                emotion: responseEmotion,
                intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
              },
            });
            emitTerminalEvent('turn_aborted', {
              reason: 'muted',
              phase: currentPhase,
            });
          } else {
            emitResult(executionPlan, 'interrupted');
            emitTerminalEvent('turn_aborted', { reason: 'superseded', phase: 'tts' });
          }
          return {
            completed: INTERACTIVE_SOURCES.includes(turnSource),
            decision: null,
          };
        }

        const playbackResult = await playback.play(plan, audioData, {
          onMotionReady: () => {
            eventEmitter.emit('motion_ready');
          },
          onMotionStart: (startedAt) => {
            motionStartedAt = startedAt;
            eventEmitter.emit('motion_start');
          },
          onSpeechStart: (startedAt) => {
            speechStartedAt = startedAt;
            if (generation === generationRef.current) {
              eventEmitter.emit('animation_start');
              setConversationState('speaking', turnSource);
            }
          },
          onSpeechEnd: () => {
            if (generation !== generationRef.current) return;
            scheduleSubtitleClear(generation);
          },
        });
        if (generation !== generationRef.current) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded' });
          return { completed: false, decision: null };
        }
        if (!playbackResult) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded' });
          return { completed: false, decision: null };
        }

        if (turnSource === 'autonomous') {
          lastAutonomousReplyRef.current = responseText;
          appendHistory([{ role: 'assistant', content: responseText }]);
        }
        setConversationState('idle', null);
        emitResult(executionPlan, 'completed', {
          interactionAction:
            interactionDecision?.action ??
            (autonomousDecision
              ? 'take_floor'
              : executionPlan.actionDecision?.action),
          spokenText: responseText,
          emotionCue: {
            emotion: responseEmotion,
            intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
          },
          motionStartedAt: playbackResult.motionStartedAt ?? motionStartedAt,
          speechStartedAt: playbackResult.speechStartedAt ?? speechStartedAt,
          speechEndedAt: playbackResult.speechEndedAt,
        });
        emitTerminalEvent('turn_completed', {
          ...(interactionDecision?.action
            ? { interactionAction: interactionDecision.action }
            : autonomousDecision
            ? {
                  interactionAction: 'take_floor',
                }
              : executionPlan.actionDecision?.action
                ? { interactionAction: executionPlan.actionDecision.action }
                : {}),
        });
        return { completed: true, decision: autonomousDecision };
      } catch (caughtError) {
        if (abortControllerRef.current === requestController) {
          abortControllerRef.current = null;
        }
        if (generation !== generationRef.current) {
          emitResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', {
            reason: 'superseded',
            phase: currentPhase,
          });
          return { completed: false, decision: null };
        }
        if (isAbortError(caughtError)) {
          clearSubtitle();
          setConversationState('idle', null);
          emitResult(executionPlan, 'cancelled');
          emitTerminalEvent('turn_aborted', { reason: 'aborted' });
          return {
            completed:
              INTERACTIVE_SOURCES.includes(turnSource) &&
              isMutedRef.current,
            decision: null,
          };
        }

        clearSubtitle();
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : '会話処理に失敗しました。',
        );
        setConversationState('error', null);
        emitResult(executionPlan, 'failed');
        emitTerminalEvent('turn_failed', {
          reason: 'request_failed',
          phase: currentPhase,
        });
        return { completed: false, decision: null };
      } finally {
        if (activeTurnControlRef.current === turnControl) {
          activeTurnControlRef.current = null;
        }
      }
    },
    [
      appendHistory,
      clearSubtitle,
      clearSubtitleTimer,
      emitResult,
      finishActivePlanAsCancelled,
      invalidateCurrentTurn,
      isExhibitionMode,
      playback,
      scheduleSubtitleClear,
      setConversationState,
    ],
  );

  const sendManual = useCallback(
    async (
      message: string,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
      plan: PerformancePlan,
    ) =>
      (
        await processTurn(
          'manual',
          message,
          cardContext,
          onReplyAccepted,
          null,
          plan,
        )
      ).completed,
    [processTurn],
  );

  const sendVoice = useCallback(
    async (
      message: string,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
      plan: PerformancePlan,
    ) =>
      (
        await processTurn(
          'voice',
          message,
          cardContext,
          onReplyAccepted,
          null,
          plan,
        )
      ).completed,
    [processTurn],
  );

  const sendAutonomous = useCallback(
    async (
      cardContext: ChatCardContext,
      autonomousContext: AutonomousContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
      plan: PerformancePlan,
    ) => {
      const result = await processTurn(
        'autonomous',
        null,
        cardContext,
        onReplyAccepted,
        autonomousContext,
        plan,
      );
      return result.completed ? result.decision : null;
    },
    [processTurn],
  );

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (!isMuted) return;

    if (sourceRef.current === 'autonomous') {
      cancelAutonomous();
      return;
    }

    if (
      INTERACTIVE_SOURCES.includes(sourceRef.current ?? 'manual') &&
      ['synthesizing', 'speaking'].includes(statusRef.current)
    ) {
      finishActivePlanAsCancelled();
      invalidateCurrentTurn(true);
      clearSubtitle();
      setConversationState('idle', null);
    }
  }, [
    cancelAutonomous,
    clearSubtitle,
    finishActivePlanAsCancelled,
    invalidateCurrentTurn,
    isMuted,
    setConversationState,
  ]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortFetch();
      clearSubtitleTimer();
      activePlanRef.current = null;
    };
  }, [abortFetch, clearSubtitleTimer]);

  const isBusy = ACTIVE_STATUSES.includes(status);

  return {
    cancelAutonomous,
    clearSubtitle,
    error,
    isBusy,
    interruptCurrentTurn,
    isManualBusy: isBusy && INTERACTIVE_SOURCES.includes(source ?? 'manual'),
    reply,
    isSubtitleVisible,
    resetConversation,
    sendAutonomous,
    sendManual,
    sendVoice,
    source,
    status,
  };
}
