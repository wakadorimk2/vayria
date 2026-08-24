import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeEmotion, type Emotion } from '../character/emotion';
import {
  DEFAULT_CHARACTER_IDENTITY,
  type CharacterIdentity,
} from '../character/identity';
import { createConversationEventEmitter } from './conversationEvents';
import { apiUrl } from '../runtimeConfig';
import {
  createFloorController,
  toTurnSignal,
  type FloorController,
  type VoiceTurnMetadata,
} from './floorController';
import {
  createParticipationController,
  type ConversationContext,
  type ParticipationController,
  type ParticipationDecision,
  type ParticipationUtteranceInput,
} from './participationController';
import {
  createInteractionTimeline,
  type InteractionTimelineEvent,
} from './interactionTimeline';
import {
  createSemanticDialogueHistory,
  DEFAULT_HISTORY_TURN_LIMIT,
} from './semanticDialogueHistory';
import type { AutonomousContext } from './autonomousContext';
export type { AutonomousContext } from './autonomousContext';
import type {
  AutonomyCandidate,
  AutonomyExternalAction,
  AutonomyInternalDelta,
} from './autonomyState';
export type {
  AutonomyCandidate,
  AutonomyExternalAction,
  AutonomyInternalDelta,
} from './autonomyState';
import {
  DEFAULT_PROGRAM_CONTEXT,
  type ProgramContext,
} from './programContext';
import type { PerformancePlayback } from '../performer/performancePlayback';
import type {
  ConversationActionDecision,
  PerformancePlan,
  PerformanceResult,
  PerformerStateContext,
} from '../performer/types';
import { isConversationActionDecision } from '../performer/types';
import type { VoiceInputEvent } from '../voice/voiceInput';

export type ConversationStatus =
  | 'idle'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export type ConversationSource = 'manual' | 'voice' | 'autonomous';

export interface AutonomousDecision {
  externalAction: AutonomyExternalAction;
  usedReasonIds: string[];
  internalDelta: AutonomyInternalDelta;
}

interface ChatResponse {
  activatedCards: unknown;
  backchannelCue?: unknown;
  emotion: unknown;
  text: string;
  externalAction?: unknown;
  usedReasonIds?: unknown;
  internalDelta?: unknown;
  interactionAction?: unknown;
}

export interface ChatCardContext {
  brainCardIds: string[];
  forcedCardId: string | null;
}

export interface PerformanceContextPayload {
  callbackTendency: number;
  fragmentation: number;
  semanticBiases: string[];
}

export interface AutonomyEvidenceContext {
  episodeId: string;
  evidenceId: string;
  reasonIds: readonly string[];
}

export interface AutonomyDeltaContext {
  source: ConversationSource;
  episodeId: string | null;
  evidenceId: string;
  reasonIds: readonly string[];
  resolvesReason: boolean;
}

interface ConversationOptions {
  historyTurnLimit?: number;
  isMuted?: boolean;
  isExhibitionMode?: boolean;
  characterIdentity?: CharacterIdentity;
  conversationContext?: ConversationContext | null;
  programContext?: ProgramContext;
  getPerformerStateContext?: () => PerformerStateContext;
  onPerformanceCue?: (
    planId: string,
    cue: { emotion: Emotion; intensity: number },
  ) => void;
  onPerformancePlan?: (plan: PerformancePlan) => void;
  onPerformanceResult?: (result: PerformanceResult) => void;
  onInteractionAction?: (decision: ConversationActionDecision) => void;
  onInteractionTimelineEvent?: (event: InteractionTimelineEvent) => void;
  onAutonomyDelta?: (
    delta: AutonomyInternalDelta,
    context: AutonomyDeltaContext,
  ) => void;
}

interface ErrorResponse {
  error?: string;
}

interface ProcessTurnResult {
  completed: boolean;
  decision: AutonomousDecision | null;
}

const MAX_HISTORY_TURN_LIMIT = 10;
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

function readAutonomyInternalDelta(value: unknown): AutonomyInternalDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI のinternalDelta形式が正しくありません。');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'reasonUpdates') ||
    !Array.isArray(record.reasonUpdates)
  ) {
    throw new Error('AI のreasonUpdates形式が正しくありません。');
  }
  return { reasonUpdates: record.reasonUpdates as AutonomyInternalDelta['reasonUpdates'] };
}

function serializeAutonomyCandidate(candidate: AutonomyCandidate) {
  return {
    episodeId: candidate.episodeId,
    decisionEvidenceIds: [...candidate.decisionEvidenceIds],
    reasons: candidate.reasons.map((reason) => ({
      id: reason.id,
      episodeId: reason.episodeId,
      parentReasonId: reason.parentReasonId,
      kind: reason.kind,
      content: reason.content,
      semanticKey: reason.semanticKey,
      salience: reason.salience,
      status: reason.status,
      deferCause: reason.deferCause,
      wakeOn: [...reason.wakeOn],
      decisionEvidenceIds: [...reason.decisionEvidenceIds],
    })),
  };
}

function readAutonomousDecision(
  action: unknown,
  usedReasonIds: unknown,
  internalDelta: unknown,
  candidate: AutonomyCandidate,
): AutonomousDecision {
  if (action !== 'speak' && action !== 'none') {
    throw new Error('AI の自律発話アクション形式が正しくありません。');
  }
  if (!Array.isArray(usedReasonIds)) {
    throw new Error('AI の使用理由形式が正しくありません。');
  }
  const normalizedUsedReasonIds = usedReasonIds.filter(
    (reasonId): reasonId is string => typeof reasonId === 'string',
  );
  if (
    normalizedUsedReasonIds.length !== usedReasonIds.length ||
    new Set(normalizedUsedReasonIds).size !== normalizedUsedReasonIds.length ||
    normalizedUsedReasonIds.some(
      (reasonId) => !candidate.reasons.some((reason) => reason.id === reasonId),
    )
  ) {
    throw new Error('AI の使用理由ID形式が正しくありません。');
  }
  if (action === 'speak' && !normalizedUsedReasonIds.length) {
    throw new Error('発話する自律応答には使用理由が必要です。');
  }
  const delta = readAutonomyInternalDelta(internalDelta);
  return {
    externalAction: action,
    usedReasonIds: normalizedUsedReasonIds,
    internalDelta: delta,
  };
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

function normalizeHistoryTurnLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_TURN_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_HISTORY_TURN_LIMIT));
}

function waitMilliseconds(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function useConversation(
  playback: PerformancePlayback,
  options: ConversationOptions = {},
) {
  const historyTurnLimit = normalizeHistoryTurnLimit(options.historyTurnLimit);
  const isMuted = options.isMuted ?? false;
  const isExhibitionMode = options.isExhibitionMode ?? false;
  const [reply, setReply] = useState('');
  const [isSubtitleVisible, setIsSubtitleVisible] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [source, setSource] = useState<ConversationSource | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const [timeline] = useState(() => createInteractionTimeline());
  const [floorController] = useState<FloorController>(() =>
    createFloorController(timeline),
  );
  const [participationController] = useState<ParticipationController>(() =>
    createParticipationController({
      context: options.conversationContext,
      characterIdentity:
        options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY,
      timeline,
    }),
  );
  const [semanticHistory] = useState(() =>
    createSemanticDialogueHistory(historyTurnLimit),
  );
  const subtitleClearTimerRef = useRef<number | null>(null);
  const lastSelfUtteranceRef = useRef<string | null>(null);
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
  const onAutonomyDeltaRef = useRef(options.onAutonomyDelta);
  const characterIdentityRef = useRef(
    options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY,
  );
  const programContextRef = useRef(
    options.programContext ?? DEFAULT_PROGRAM_CONTEXT,
  );
  const getPerformerStateContextRef = useRef(options.getPerformerStateContext);

  useEffect(() => {
    onPerformanceCueRef.current = options.onPerformanceCue;
    onPerformancePlanRef.current = options.onPerformancePlan;
    onPerformanceResultRef.current = options.onPerformanceResult;
    onInteractionActionRef.current = options.onInteractionAction;
    onAutonomyDeltaRef.current = options.onAutonomyDelta;
    timeline.setListener(options.onInteractionTimelineEvent);
  }, [
    options.onPerformanceCue,
    options.onPerformancePlan,
    options.onPerformanceResult,
    options.onInteractionAction,
    options.onInteractionTimelineEvent,
    options.onAutonomyDelta,
    timeline,
  ]);

  useEffect(() => {
    characterIdentityRef.current =
      options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY;
    participationController.setCharacterIdentity(characterIdentityRef.current);
  }, [options.characterIdentity, participationController]);

  useEffect(() => {
    participationController.setContext(options.conversationContext);
  }, [options.conversationContext, participationController]);

  useEffect(() => {
    programContextRef.current =
      options.programContext ?? DEFAULT_PROGRAM_CONTEXT;
  }, [options.programContext]);

  useEffect(() => {
    getPerformerStateContextRef.current = options.getPerformerStateContext;
  }, [options.getPerformerStateContext]);

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
    semanticHistory.clear();
    floorController.reset('conversation_reset');
    participationController.reset();
    lastSelfUtteranceRef.current = null;
    clearSubtitle();
    setReply('');
    setError('');
    setConversationState('idle', null);
  }, [
    clearSubtitle,
    finishActivePlanAsCancelled,
    floorController,
    invalidateCurrentTurn,
    participationController,
    semanticHistory,
    setConversationState,
  ]);

  const previewVoiceMessage = useCallback(
    (message: string) => floorController.preview(message).candidateText,
    [floorController],
  );

  const recordVoiceSignal = useCallback(
    (event: VoiceInputEvent) => {
      if (event.type === 'speech_started') {
        participationController.observeSpeechStarted({
          speakerId: event.speakerId,
          at: event.at,
        });
      } else if (event.type === 'speech_ended') {
        participationController.observeSpeechEnded({
          speakerId: event.speakerId,
          at: event.at,
        });
      } else if (
        event.type === 'recognition_failed' ||
        event.type === 'recognition_stopped'
      ) {
        participationController.reset();
      }

      if (
        event.type === 'interim_transcript_updated' ||
        event.type === 'listening_started'
      ) {
        return;
      }
      floorController.observeSignal(toTurnSignal(event));
    },
    [floorController, participationController],
  );

  const evaluateVoiceParticipation = useCallback(
    (
      input: ParticipationUtteranceInput,
      characterIdentityOverride?: CharacterIdentity,
    ): ParticipationDecision => {
      const decision = participationController.evaluateFinalized(
        input,
        characterIdentityOverride ?? characterIdentityRef.current,
      );
      if (
        decision.mode === 'multi_party' &&
        decision.decision === 'SILENT'
      ) {
        floorController.release('participation_silent', input.at ?? Date.now());
      }
      return decision;
    },
    [floorController, participationController],
  );

  const processTurn = useCallback(
    async (
      turnSource: ConversationSource,
      message: string | null,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
      autonomousContext: AutonomousContext | null,
      plan: PerformancePlan,
      voiceMetadata?: VoiceTurnMetadata,
      characterIdentityOverride?: CharacterIdentity,
      programContextOverride?: ProgramContext,
      autonomyCandidate: AutonomyCandidate | null = null,
      autonomyEvidenceContext: AutonomyEvidenceContext | null = null,
    ): Promise<ProcessTurnResult> => {
      const eventEmitter = createConversationEventEmitter(turnSource);
      const messageForRequest = message;
      const programContextForRequest =
        programContextOverride ?? programContextRef.current;
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
      if (turnSource === 'manual') {
        floorController.reset('manual_input');
      }

      if (turnSource === 'autonomous') {
        if (!autonomyCandidate) {
          emitTerminalEvent('turn_aborted', { reason: 'missing_candidate' });
          return { completed: false, decision: null };
        }
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
      const finalizedVoiceMetadata: VoiceTurnMetadata =
        voiceMetadata ?? {
          segmentId: eventEmitter.turnId,
          at: Date.now(),
          asrConfidence: null,
        };
      if (localInteractionDecision) {
        const reactionPlan = createInteractionReactionPlan(plan);
        activePlanRef.current = plan;
        onPerformancePlanRef.current?.(reactionPlan);
        playback.prepare(reactionPlan);
        if (turnSource === 'voice') {
          floorController.applyFinalized(
            message ?? '',
            localInteractionDecision,
            finalizedVoiceMetadata,
          );
        }
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
      const performerStateContext =
        turnSource === 'autonomous'
          ? getPerformerStateContextRef.current?.() ?? null
          : null;

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
            ...(messageForRequest === null
              ? {}
              : { message: messageForRequest }),
            history: semanticHistory.toMessages(),
            characterIdentity:
              characterIdentityOverride ?? characterIdentityRef.current,
            programContext: programContextForRequest,
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
                  viewerIntent: autonomousContext?.viewerIntent ?? null,
                  viewerTurnsSince: autonomousContext?.viewerTurnsSince ?? 0,
                  viewerEngagement:
                    autonomousContext?.viewerEngagement ?? 'available',
                  lastSelfUtterance: lastSelfUtteranceRef.current,
                  performerState: performerStateContext,
                  autonomyCandidate: serializeAutonomyCandidate(autonomyCandidate!),
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
                chatPayload.externalAction,
                chatPayload.usedReasonIds,
                chatPayload.internalDelta,
                autonomyCandidate!,
              )
            : null;
        const internalDelta =
          turnSource === 'autonomous'
            ? autonomousDecision?.internalDelta ?? { reasonUpdates: [] }
            : chatPayload.internalDelta === undefined
              ? { reasonUpdates: [] }
              : readAutonomyInternalDelta(chatPayload.internalDelta);
        const autonomyDeltaContext = {
          source: turnSource,
          episodeId:
            autonomyCandidate?.episodeId ??
            autonomyEvidenceContext?.episodeId ??
            null,
          evidenceId:
            autonomyCandidate?.decisionEvidenceIds.at(-1) ??
            autonomyEvidenceContext?.evidenceId ??
            finalizedVoiceMetadata.segmentId,
          reasonIds: [
            ...(autonomousDecision?.externalAction === 'speak'
              ? autonomousDecision.usedReasonIds
              : autonomyCandidate
                ? []
                : (autonomyEvidenceContext?.reasonIds ?? [])),
          ],
          resolvesReason:
            turnSource === 'autonomous'
              ? autonomousDecision?.externalAction === 'speak'
              : interactionDecision === null ||
                interactionDecision.action === 'take_floor',
        };
        if (
          (INTERACTIVE_SOURCES.includes(turnSource) &&
            interactionDecision?.action === 'take_floor' &&
            !responseText) ||
          (interactionDecision !== null &&
            interactionDecision.action !== 'take_floor' &&
            responseText) ||
          (autonomousDecision?.externalAction === 'speak' &&
            autonomousDecision !== null &&
            !responseText) ||
          (autonomousDecision?.externalAction === 'none' && responseText)
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
        if (autonomousDecision?.externalAction === 'none' && activatedCards.length) {
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
          (autonomousDecision === null ||
            autonomousDecision.externalAction === 'speak') &&
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
          if (turnSource === 'voice') {
            floorController.applyFinalized(
              message ?? '',
              interactionDecision,
              finalizedVoiceMetadata,
            );
          }
          setConversationState('idle', null);
          emitResult(reactionPlan, 'completed', {
            interactionAction: interactionDecision.action,
            emotionCue: { emotion: 'neutral', intensity: 0 },
          });
          onInteractionActionRef.current?.(interactionDecision);
          onAutonomyDeltaRef.current?.(internalDelta, autonomyDeltaContext);
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
        if (autonomousDecision?.externalAction === 'none') {
          onReplyAccepted([]);
          onAutonomyDeltaRef.current?.(internalDelta, autonomyDeltaContext);
          setConversationState('idle', null);
          emitResult(executionPlan, 'completed', {
            emotionCue: { emotion: responseEmotion, intensity: 0 },
          });
          emitTerminalEvent('turn_completed', {
            reason: 'no_external_action',
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
          if (turnSource === 'voice' && interactionDecision) {
            const floorTransition = floorController.applyFinalized(
              message ?? '',
              interactionDecision,
              finalizedVoiceMetadata,
            );
            if (floorTransition.action === 'take_floor' && !responseText) {
              throw new Error('TAKE_FLOOR response must contain text.');
            }
            if (floorTransition.committedText) {
              semanticHistory.commitTurn(
                floorTransition.committedText,
                responseText,
                finalizedVoiceMetadata.at,
              );
            }
          } else if (turnSource === 'manual') {
            semanticHistory.commitTurn(
              message ?? '',
              responseText,
            );
          }
        }

        if (isMutedRef.current) {
          if (turnSource === 'voice') {
            floorController.release('muted');
          }
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
        timeline.record({
          kind: 'tts_event',
          at: Date.now(),
          phase: 'start',
          channel: 'server_tts',
        });
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
        timeline.record({
          kind: 'tts_event',
          at: Date.now(),
          phase: 'ready',
          channel: 'server_tts',
          durationMs: performance.now() - ttsStartedAt,
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

        lastSelfUtteranceRef.current = responseText;
        onAutonomyDeltaRef.current?.(internalDelta, autonomyDeltaContext);
        if (turnSource === 'autonomous') {
          semanticHistory.appendAssistant(responseText);
        }
        if (turnSource === 'voice') {
          floorController.release('response_completed');
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
          if (turnSource === 'voice') {
            floorController.release('aborted');
          }
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

        if (turnSource === 'voice') {
          floorController.reset('take_floor_failed');
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
        if (turnSource === 'voice' && floorController.getState().floorOwner === 'vayria') {
          floorController.release('turn_ended');
        }
        if (activeTurnControlRef.current === turnControl) {
          activeTurnControlRef.current = null;
        }
      }
    },
    [
      clearSubtitle,
      clearSubtitleTimer,
      emitResult,
      finishActivePlanAsCancelled,
      floorController,
      invalidateCurrentTurn,
      isExhibitionMode,
      playback,
      semanticHistory,
      scheduleSubtitleClear,
      setConversationState,
      timeline,
    ],
  );

  const sendManual = useCallback(
    async (
      message: string,
      cardContext: ChatCardContext,
      onReplyAccepted: (activatedCardIds: string[]) => void,
      plan: PerformancePlan,
      characterIdentityOverride?: CharacterIdentity,
      programContextOverride?: ProgramContext,
      autonomyEvidenceContext?: AutonomyEvidenceContext,
    ) =>
      (
        await processTurn(
          'manual',
          message,
          cardContext,
          onReplyAccepted,
          null,
          plan,
          undefined,
          characterIdentityOverride,
          programContextOverride,
          undefined,
          autonomyEvidenceContext ?? null,
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
      voiceMetadata?: VoiceTurnMetadata,
      characterIdentityOverride?: CharacterIdentity,
      programContextOverride?: ProgramContext,
      autonomyEvidenceContext?: AutonomyEvidenceContext,
    ) =>
      (
        await processTurn(
          'voice',
          message,
          cardContext,
          onReplyAccepted,
          null,
          plan,
          voiceMetadata,
          characterIdentityOverride,
          programContextOverride,
          undefined,
          autonomyEvidenceContext ?? null,
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
      programContextOverride?: ProgramContext,
      autonomyCandidate?: AutonomyCandidate,
    ) => {
      const result = await processTurn(
        'autonomous',
        null,
        cardContext,
        onReplyAccepted,
        autonomousContext,
        plan,
        undefined,
        undefined,
        programContextOverride,
        autonomyCandidate ?? null,
        null,
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
    evaluateVoiceParticipation,
    isBusy,
    interruptCurrentTurn,
    isManualBusy: isBusy && INTERACTIVE_SOURCES.includes(source ?? 'manual'),
    reply,
    isSubtitleVisible,
    previewVoiceMessage,
    recordVoiceSignal,
    resetConversation,
    sendAutonomous,
    sendManual,
    sendVoice,
    source,
    status,
  };
}
