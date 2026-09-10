import { splitSpeechAtBoundaries, type CardContinuation } from './cardContinuation.js';
/** Session-local conversation execution. Only the current generation can publish or deliver speech. */
import type { ConversationEventName, ConversationEventDetails } from './conversationEventTypes.js';
import { readAudioPlaybackSource } from '../audio/audioPlaybackSource.js';
import { normalizeEmotion, type Emotion } from '../character/emotion.js';
import {
  DEFAULT_CHARACTER_IDENTITY,
  type CharacterIdentity,
} from '../character/identity.js';
import type {
  PerformancePlayback,
  PerformancePlaybackResult,
} from '../performer/performancePlayback.js';
import type {
  ConversationActionDecision,
  PerformancePlan,
  PerformanceResult,
  PerformerStateContext,
  PerformerTrigger,
  WeightedSemanticCue,
} from '../performer/types.js';
import { isConversationActionDecision } from '../performer/types.js';
import type { VoiceInputEvent } from '../voice/voiceInput.js';
import type { AutonomousContext } from './autonomousContext.js';
import type {
  AutonomyCandidate,
  AutonomyExternalAction,
  AutonomyInternalDelta,
} from './autonomyState.js';
import {
  createFloorController,
  toTurnSignal,
  type FloorController,
  type VoiceTurnMetadata,
} from './floorController.js';
import {
  createInteractionTimeline,
  type InteractionTimelineEvent,
} from './interactionTimeline.js';
import {
  createParticipationController,
  type ConversationContext,
  type ParticipationController,
  type ParticipationDecision,
  type ParticipationUtteranceInput,
} from './participationController.js';
import {
  DEFAULT_PROGRAM_CONTEXT,
  type ProgramContext,
} from './programContext.js';
import {
  createSemanticDialogueHistory,
  DEFAULT_HISTORY_TURN_LIMIT,
  type SemanticDialogueMessage,
} from './semanticDialogueHistory.js';
import { readStreamingChatEvents } from './streamingSpeech.js';
import {
  isExpressionLevel,
  isSpeechAct,
  type ExpressionLevel,
  type SpeechAct,
} from './utterancePlan.js';
export type { AutonomousContext } from './autonomousContext.js';
export type {
  AutonomyCandidate,
  AutonomyExternalAction,
  AutonomyInternalDelta
} from './autonomyState.js';

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
  speechAct: unknown;
  expressionLevel: unknown;
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
  swapRevision?: number;
}

export interface PerformanceContextPayload {
  callbackTendency: number;
  fragmentation: number;
  semanticBiases: WeightedSemanticCue[];
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

export interface ConversationOptions {
  historyTurnLimit?: number;
  isMuted?: boolean;
  isExhibitionMode?: boolean;
  characterIdentity?: CharacterIdentity;
  conversationContext?: ConversationContext | null;
  programContext?: ProgramContext;
  getPerformerStateContext?: () => PerformerStateContext;
  createCardContinuationPlan?: (trigger: PerformerTrigger) => PerformancePlan;
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
  onReplyPresentationStart?: (
    planId: string,
    activatedCardIds: string[],
    speechAct: SpeechAct,
  ) => void;
  onReplyPresentationEnd?: (planId: string) => void;
}

interface ErrorResponse {
  error?: string;
}

interface ProcessTurnResult {
  completed: boolean;
  decision: AutonomousDecision | null;
  cardChange?: PendingCardContinuation;
}

/** Local ownership and history retained across the replacement generation. */
interface PendingCardContinuation {
  cards: ChatCardContext;
  generation: number;
  continuation: CardContinuation;
  historyTurnId: string;
  nextUnitIndex: number;
  history: SemanticDialogueMessage[];
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
    value.length > 2 ||
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



export interface ConversationDependencies {
  fetch: typeof fetch;
  config: { streamingSpeechEnabled: boolean; earlySpeechLeadEnabled: boolean; cloudTtsStreamPlaybackEnabled: boolean };
  createEventEmitter: (source: ConversationSource) => { turnId: string; runId?: string | null; emit: (event: ConversationEventName, details?: ConversationEventDetails) => void };
  now: () => number;
  monotonicNow: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  prefersReducedMotion: () => boolean;
}

export function createConversationRuntime(playback: PerformancePlayback, options: ConversationOptions, dependencies: ConversationDependencies) {
  const runtimeConfig = dependencies.config;
  const createConversationEventEmitter = dependencies.createEventEmitter;
  const waitMilliseconds = (delayMs: number): Promise<void> => delayMs <= 0 ? Promise.resolve() : new Promise(resolve => dependencies.setTimeout(resolve, delayMs));
  const listeners = new Set<() => void>();
  const historyTurnLimit = normalizeHistoryTurnLimit(options.historyTurnLimit);
  let isMuted = options.isMuted ?? false;
  let isExhibitionMode = options.isExhibitionMode ?? false;
  let reply: string = '';
  const setReply = (value: string) => { if (reply === value) return; reply = value; publish(); };
  let isSubtitleVisible: boolean = false;
  const setIsSubtitleVisible = (value: boolean) => { if (isSubtitleVisible === value) return; isSubtitleVisible = value; publish(); };
  let error: string = '';
  const setError = (value: string) => { if (error === value) return; error = value; publish(); };
  let status: ConversationStatus = 'idle';
  let source: ConversationSource | null = null;
  const abortControllerRef: { current: AbortController | null } = { current: null };
  const generationRef = { current: 0 };
  const timeline = createInteractionTimeline();
  const floorController: FloorController = createFloorController(timeline);
  const participationController: ParticipationController = createParticipationController({
    context: options.conversationContext,
    characterIdentity:
      options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY,
    timeline,
  });
  const semanticHistory = createSemanticDialogueHistory(historyTurnLimit);
  const subtitleClearTimerRef: { current: number | null } = { current: null };
  const lastSelfUtteranceRef: { current: string | null } = { current: null };
  const recentExpressionLevelsRef: { current: ExpressionLevel[] } = { current: [] };
  const activePresentationPlanIdRef: { current: string | null } = { current: null };
  const isMutedRef = { current: isMuted };
  const sourceRef: { current: ConversationSource | null } = { current: null };
  const statusRef: { current: ConversationStatus } = { current: 'idle' };
  let acknowledgedCardRevision: number | undefined;
  const activeDeliveredTextRef = { current: '' };
  const activePlanRef: { current: PerformancePlan | null } = { current: null };
  const activeTurnControlRef: {
    current: {
      interrupt: (reason: string) => void;
      changeCards: (cards: ChatCardContext) => boolean;
    } | null
  } = { current: null };
  const onPerformanceCueRef = { current: options.onPerformanceCue };
  const onPerformancePlanRef = { current: options.onPerformancePlan };
  const onPerformanceResultRef = { current: options.onPerformanceResult };
  const onInteractionActionRef = { current: options.onInteractionAction };
  const onAutonomyDeltaRef = { current: options.onAutonomyDelta };
  const onReplyPresentationStartRef = { current: options.onReplyPresentationStart };
  const onReplyPresentationEndRef = { current: options.onReplyPresentationEnd };
  const characterIdentityRef = { current: options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY };
  const programContextRef = { current: options.programContext ?? DEFAULT_PROGRAM_CONTEXT };
  const getPerformerStateContextRef = { current: options.getPerformerStateContext };
  const setConversationState = (nextStatus: ConversationStatus, nextSource: ConversationSource | null) => {
    statusRef.current = nextStatus;
    sourceRef.current = nextSource;
    status = nextStatus;
    source = nextSource;
    publish();
  };
  const emitResult = (plan: PerformancePlan, outcome: PerformanceResult['outcome'], extras: Omit<Partial<PerformanceResult>, 'planId' | 'completedAt' | 'outcome' | 'trigger' | 'intent'> = {}) => {
    if (activePlanRef.current?.planId !== plan.planId)
      return;
    activePlanRef.current = null;
    onPerformanceResultRef.current?.({
      planId: plan.planId,
      completedAt: dependencies.now(),
      outcome,
      ...(activeDeliveredTextRef.current ? { spokenText: activeDeliveredTextRef.current } : {}),
      trigger: plan.trigger,
      intent: plan.intent,
      ...extras,
    });
  };
  const finishActivePlanAsCancelled = () => {
    const plan = activePlanRef.current;
    if (!plan)
      return;
    emitResult(plan, 'cancelled');
  };
  const abortFetch = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };
  const clearSubtitleTimer = () => {
    if (subtitleClearTimerRef.current === null)
      return;
    dependencies.clearTimeout(subtitleClearTimerRef.current);
    subtitleClearTimerRef.current = null;
  };
  const clearSubtitle = () => {
    clearSubtitleTimer();
    setIsSubtitleVisible(false);
  };
  const scheduleSubtitleClear = (generation: number) => {
    if (!isExhibitionMode)
      return;
    clearSubtitleTimer();
    const timerId = dependencies.setTimeout(() => {
      if (subtitleClearTimerRef.current !== timerId)
        return;
      subtitleClearTimerRef.current = null;
      if (generation !== generationRef.current)
        return;
      setIsSubtitleVisible(false);
    }, SUBTITLE_HOLD_MS);
    subtitleClearTimerRef.current = timerId;
  };
  const invalidateCurrentTurn = (stopPlayback: boolean) => {
    generationRef.current += 1;
    abortFetch();
    if (stopPlayback)
      playback.stop();
    const presentationPlanId = activePresentationPlanIdRef.current;
    if (presentationPlanId) {
      activePresentationPlanIdRef.current = null;
      onReplyPresentationEndRef.current?.(presentationPlanId);
    }
  };
  const changeCardsDuringTurn = (cards: ChatCardContext) => activeTurnControlRef.current?.changeCards(cards) ?? false;
  const interruptCurrentTurn = (reason = 'interrupted') => {
    activeTurnControlRef.current?.interrupt(reason);
    const plan = activePlanRef.current;
    if (plan)
      emitResult(plan, 'interrupted');
    invalidateCurrentTurn(true);
    clearSubtitle();
    setError('');
    setConversationState('idle', null);
  };
  const cancelAutonomous = () => {
    if (sourceRef.current !== 'autonomous')
      return;
    finishActivePlanAsCancelled();
    invalidateCurrentTurn(true);
    clearSubtitle();
    setError('');
    setConversationState('idle', null);
  };
  const resetConversation = () => {
    finishActivePlanAsCancelled();
    invalidateCurrentTurn(true);
    humanSpeechPending = false;
    acknowledgedCardRevision = undefined;
    semanticHistory.clear();
    floorController.reset('conversation_reset');
    participationController.reset();
    lastSelfUtteranceRef.current = null;
    recentExpressionLevelsRef.current = [];
    clearSubtitle();
    setReply('');
    setError('');
    setConversationState('idle', null);
  };
  const previewVoiceMessage = (message: string) => floorController.preview(message).candidateText;
  let humanSpeechPending = false;
  const recordVoiceSignal = (event: VoiceInputEvent) => {
    if (event.type === 'speech_started') {
      humanSpeechPending = true;
      participationController.observeSpeechStarted({
        speakerId: event.speakerId,
        at: event.at,
      });
    }
    else if (event.type === 'speech_ended') {
      participationController.observeSpeechEnded({
        speakerId: event.speakerId,
        at: event.at,
      });
    }
    else if (event.type === 'recognition_failed' ||
      event.type === 'recognition_stopped') {
      participationController.reset();
    }
    if (event.type === 'interim_transcript_updated' ||
      event.type === 'listening_started') {
      return;
    }
    if (event.type === 'utterance_finalized' || event.type === 'recognition_failed' || event.type === 'recognition_stopped') humanSpeechPending = false;
    floorController.observeSignal(toTurnSignal(event));
  };
  const evaluateVoiceParticipation = (input: ParticipationUtteranceInput, characterIdentityOverride?: CharacterIdentity): ParticipationDecision => {
    const decision = participationController.evaluateFinalized(input, characterIdentityOverride ?? characterIdentityRef.current);
    if (decision.mode === 'multi_party' &&
      decision.decision === 'SILENT') {
      floorController.release('participation_silent', input.at ?? dependencies.now());
    }
    return decision;
  };
  const processTurn = async (turnSource: ConversationSource, message: string | null, cardContext: ChatCardContext, onReplyAccepted: (activatedCardIds: string[], swapRevision?: number) => void, autonomousContext: AutonomousContext | null, plan: PerformancePlan, voiceMetadata?: VoiceTurnMetadata, characterIdentityOverride?: CharacterIdentity, programContextOverride?: ProgramContext, autonomyCandidate: AutonomyCandidate | null = null, autonomyEvidenceContext: AutonomyEvidenceContext | null = null, continuationState?: NonNullable<ProcessTurnResult['cardChange']>): Promise<ProcessTurnResult> => {
    const eventEmitter = createConversationEventEmitter(turnSource);
    const messageForRequest = message;
    const programContextForRequest = { ...(programContextOverride ?? programContextRef.current), ...(programContextRef.current.worldContext ? { worldContext: programContextRef.current.worldContext } : {}) };
    const isCardChangeTurn = turnSource === 'autonomous' &&
      cardContext.forcedCardId !== null &&
      programContextForRequest.phase === 'after_card_change';
    let terminalEventEmitted = false;
    const emitTerminalEvent = (event: 'turn_completed' | 'turn_aborted' | 'turn_failed', details: Parameters<typeof eventEmitter.emit>[1] = {}) => {
      if (terminalEventEmitted)
        return;
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
      if (isMutedRef.current ||
        ACTIVE_STATUSES.includes(statusRef.current)) {
        emitTerminalEvent('turn_aborted', {
          reason: isMutedRef.current ? 'muted' : 'busy',
        });
        return { completed: false, decision: null };
      }
    }
    else {
      if (sourceRef.current === 'manual' && statusRef.current !== 'idle') {
        emitTerminalEvent('turn_aborted', { reason: 'busy' });
        return { completed: false, decision: null };
      }
      if (sourceRef.current === 'autonomous') {
        finishActivePlanAsCancelled();
        invalidateCurrentTurn(true);
      }
    }
    if (sourceRef.current === 'voice' && ACTIVE_STATUSES.includes(statusRef.current)) {
      finishActivePlanAsCancelled();
      invalidateCurrentTurn(true);
    }
    const historyForRequest = continuationState?.history ?? semanticHistory.toMessages();
    clearSubtitle();
    const pendingPlan = turnSource === 'voice' ? createInteractionReactionPlan(plan) : plan;
    let executionPlan = pendingPlan;
    activePlanRef.current = plan;
    onPerformancePlanRef.current?.(pendingPlan);
    playback.prepare(pendingPlan);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const emitOwnedResult: typeof emitResult = (...args) => {
      if (generation === generationRef.current) emitResult(...args);
    };
    const historyTurnId = continuationState?.historyTurnId ?? eventEmitter.turnId;
    semanticHistory.beginTurn(historyTurnId, message, dependencies.now());
    let nextUnitIndex = continuationState?.nextUnitIndex ?? 0;
    const unitIndexOffset = nextUnitIndex;
    activeDeliveredTextRef.current = "";
    const textOnlyTurn = isMutedRef.current;
    let deliveredText = "";
    let unitCancelledBeforeSpeech = false;
    let releaseAudioCapture: (() => void) | undefined;
    const guard = <T extends unknown[]>(callback: ((...args: T) => void) | undefined) => (...args: T) => {
      if (generation === generationRef.current && !unitCancelledBeforeSpeech) callback?.(...args);
    };
    const playOwned: PerformancePlayback['play'] = (ownedPlan, audio, callbacks = {}) => {
      if (generation !== generationRef.current) return Promise.resolve(null);
      releaseAudioCapture ??= playback.holdAudioCapture?.();
      return playback.play(ownedPlan, audio, {
        ...callbacks,
        onAudioComplete: guard(callbacks.onAudioComplete),
        onFirstAudioReady: guard(callbacks.onFirstAudioReady),
        onMotionReady: guard(callbacks.onMotionReady),
        onMotionStart: guard(callbacks.onMotionStart),
        onPlaybackGestureRequired: guard(callbacks.onPlaybackGestureRequired),
        onPlaybackStartup: guard(callbacks.onPlaybackStartup),
        onSpeechStart: guard(callbacks.onSpeechStart),
        onSpeechEnd: guard(callbacks.onSpeechEnd),
      });
    };
    const recordDelivered = (index: number, text: string) => {
      if (generation !== generationRef.current || unitCancelledBeforeSpeech) return;
      const delivered = semanticHistory.appendDeliveredUnit(historyTurnId, unitIndexOffset + index, text);
      if (delivered !== null && index === 0 && cardContext.forcedCardId) acknowledgedCardRevision = cardContext.swapRevision;
      nextUnitIndex = Math.max(nextUnitIndex, unitIndexOffset + index + 1);
      if (delivered !== null) { deliveredText = delivered; activeDeliveredTextRef.current = delivered; lastSelfUtteranceRef.current = delivered; }
    };
    setError('');
    setConversationState('thinking', turnSource);
    const localInteractionDecision = INTERACTIVE_SOURCES.includes(turnSource) &&
      plan.actionDecision &&
      plan.actionDecision.action !== 'take_floor'
      ? plan.actionDecision
      : null;
    const finalizedVoiceMetadata: VoiceTurnMetadata = voiceMetadata ?? {
      segmentId: eventEmitter.turnId,
      at: dependencies.now(),
      asrConfidence: null,
    };
    if (localInteractionDecision) {
      const reactionPlan = createInteractionReactionPlan(plan);
      activePlanRef.current = plan;
      onPerformancePlanRef.current?.(reactionPlan);
      playback.prepare(reactionPlan);
      if (turnSource === 'voice') {
        floorController.applyFinalized(message ?? '', localInteractionDecision, finalizedVoiceMetadata);
      }
      setConversationState('idle', null);
      emitOwnedResult(reactionPlan, 'completed', {
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
    let pendingCardChange: ChatCardContext | null = null;
    let unitPlaying = false;
    let playbackPending = false;
    const cardChanged = () => { if (pendingCardChange) throw new DOMException('Card changed', 'AbortError'); };
    const turnControl = {
      changeCards: (cards: ChatCardContext) => {
        if (generation !== generationRef.current || !ACTIVE_STATUSES.includes(statusRef.current)) return false;
        if (cards.swapRevision === cardContext.swapRevision && cards.forcedCardId === cardContext.forcedCardId) return false;
        pendingCardChange = { ...cards, brainCardIds: [...cards.brainCardIds] };
        if (!unitPlaying) {
          unitCancelledBeforeSpeech = true;
          abortFetch();
          if (playbackPending) playback.stop();
        }
        return true;
      },
      interrupt: (reason: string) => {
        pendingCardChange = null;
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
    let streamingModeUsed = false;
    let streamingSpeechStarted = false;
    let streamingTtsStartedAt: number | null = null;
    let streamingFirstAudioEmitted = false;
    let streamingPlaybackStarted = false;
    let streamingPlaybackQueue = Promise.resolve<PerformancePlaybackResult | null>(null);
    let streamingFirstResult: PerformancePlaybackResult | null = null;
    let streamingLastResult: PerformancePlaybackResult | null = null;
    let streamedChatPayload: ChatResponse | null = null;
    let previousStreamingUnitEndedAt: number | null = null;
    const streamingUnitIndexes = new Set<number>();
    const performerStateContext = turnSource === 'autonomous'
      ? getPerformerStateContextRef.current?.() ?? null
      : null;
    try {
      if (turnSource === 'autonomous' && !isCardChangeTurn) {
        await waitMilliseconds(plan.preReaction?.leadBeforeSpeechMs ?? 0);
      }
      if (generation !== generationRef.current) {
        emitOwnedResult(pendingPlan, 'interrupted');
        emitTerminalEvent('turn_aborted', { reason: 'superseded' });
        return { completed: false, decision: null };
      }
      const chatController = new AbortController();
      requestController = chatController;
      abortControllerRef.current = chatController;
      const llmStartedAt = dependencies.monotonicNow();
      eventEmitter.emit('llm_start', { phase: 'llm' });
      const enqueueSpeechUnit = (index: number, text: string, candidate: ChatResponse) => {
        if (generation !== generationRef.current || pendingCardChange ||
          streamingUnitIndexes.has(index) ||
          !text.trim()) {
          return;
        }
        streamingUnitIndexes.add(index);
        streamingSpeechStarted = true;
        if (streamingTtsStartedAt === null) {
          streamingTtsStartedAt = dependencies.monotonicNow();
          currentPhase = 'tts';
          eventEmitter.emit('speech_unit_ready');
          eventEmitter.emit('tts_start', { phase: 'tts' });
          timeline.record({ kind: 'tts_event', at: dependencies.now(), phase: 'start', channel: 'server_tts' });
          setConversationState('synthesizing', turnSource);
        }
        const unitTtsStartedAt = dependencies.monotonicNow();
        eventEmitter.emit('tts_unit_start', { phase: 'tts', unitIndex: index });
        let unitAudioReadyEmitted = false;
        const emitUnitAudioReady = (readyAt: number) => {
          if (unitAudioReadyEmitted)
            return;
          unitAudioReadyEmitted = true;
          eventEmitter.emit('tts_unit_audio_ready', {
            durationMs: readyAt - unitTtsStartedAt,
            phase: 'tts',
            unitIndex: index,
          });
        };
        const audioPromise = dependencies.fetch('/api/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Performer-Turn-Id': eventEmitter.turnId,
            ...(eventEmitter.runId
              ? { 'X-Performer-Run-Id': eventEmitter.runId }
              : {}),
          },
          body: JSON.stringify({
            text: text.trim(),
            emotion: normalizeEmotion(candidate.emotion),
            ttsProfile: plan.ttsProfile,
            unitIndex: index,
          }),
          signal: chatController.signal,
        }).then(async (ttsResponse) => {
          if (!ttsResponse.ok) {
            throw new Error(await readError(ttsResponse, '返答音声を生成できませんでした。'));
          }
          const audioSource = await readAudioPlaybackSource(ttsResponse, {
            streamMpegPlayback: runtimeConfig.cloudTtsStreamPlaybackEnabled,
          });
          if (audioSource.kind === 'buffer') {
            emitUnitAudioReady(dependencies.monotonicNow());
          }
          if (audioSource.kind === 'buffer' && !streamingFirstAudioEmitted) {
            streamingFirstAudioEmitted = true;
            eventEmitter.emit('tts_first_audio', {
              durationMs: dependencies.monotonicNow() - (streamingTtsStartedAt ?? unitTtsStartedAt),
              phase: 'tts',
            });
          }
          return audioSource;
        });
        void audioPromise.catch(() => { });
        streamingPlaybackQueue = streamingPlaybackQueue.then(async () => {

          if (generation !== generationRef.current) return null;
          cardChanged();
          const audioSource = await audioPromise;
          if (generation !== generationRef.current) return null;
          cardChanged();
          const unitPlan: PerformancePlan = {
            ...plan,
            ...(index === 0 ? {} : { motion: undefined }),
            ...(plan.avatarProfile
              ? {
                avatarProfile: {
                  ...plan.avatarProfile,
                  expressionHoldMs: 0,
                },
              }
              : {}),
            timing: {
              ...plan.timing,
              motionLeadMs: index === 0 ? plan.timing.motionLeadMs : 0,
              postSpeechHoldMs: 0,
            },
          };
          playbackPending = true;
          const result = await playOwned(unitPlan, audioSource, {
            ...(turnSource === 'voice' ? { streamPriming: { targetMs: 150, maximumWaitMs: 300 } } : {}),
            onAudioComplete: () => recordDelivered(index, text),
            onMotionReady: () => eventEmitter.emit('motion_ready'),
            onMotionStart: (at) => { motionStartedAt = at; eventEmitter.emit('motion_start'); },
            onPlaybackStartup: (diagnostic) => {
              if (turnSource !== 'voice') return;
              eventEmitter.emit('playback_startup', {
                audioContextState: ['running', 'suspended', 'closed'].includes(diagnostic.audioContextState) ? diagnostic.audioContextState as 'running' | 'suspended' | 'closed' : undefined,
                audioSourceKind: diagnostic.sourceKind, bufferedDurationMs: diagnostic.bufferedDurationMs,
                firstChunkBytes: diagnostic.firstChunkBytes, firstChunkIntervalMs: diagnostic.firstChunkIntervalMs,
                phase: 'tts', playbackRoute: 'conversation', primingOutcome: diagnostic.primingOutcome,
                primingTargetMs: diagnostic.primingTargetMs, primingWaitMs: diagnostic.primingWaitMs, sampleRateHz: diagnostic.sampleRateHz,
              });
            },
            onFirstAudioReady: (readyAt) => {
              if (isSpeechAct(candidate.speechAct) && activePresentationPlanIdRef.current !== plan.planId) {
                activePresentationPlanIdRef.current = plan.planId;
                onReplyPresentationStartRef.current?.(plan.planId, readActivatedCards(candidate.activatedCards), candidate.speechAct);
              }
              emitUnitAudioReady(readyAt);
              if (streamingFirstAudioEmitted)
                return;
              streamingFirstAudioEmitted = true;
              eventEmitter.emit('tts_first_audio', {
                durationMs: readyAt - (streamingTtsStartedAt ?? unitTtsStartedAt),
                phase: 'tts',
              });
            },
            onPlaybackGestureRequired: (reason) => {
              eventEmitter.emit('playback_gesture_required', {
                phase: 'tts',
                reason,
              });
            },
            onSpeechStart: (startedAt) => {
              unitPlaying = true;
              setReply(text.trim());
              if (isExhibitionMode) { clearSubtitleTimer(); setIsSubtitleVisible(true); }
              if (previousStreamingUnitEndedAt !== null && index > 0) {
                eventEmitter.emit('tts_queue_gap', {
                  durationMs: Math.max(0, startedAt - previousStreamingUnitEndedAt),
                  phase: 'tts',
                  unitIndex: index,
                });
              }
              eventEmitter.emit('tts_unit_playback_started', {
                phase: 'tts',
                unitIndex: index,
              });
              if (streamingPlaybackStarted)
                return;
              streamingPlaybackStarted = true;
              speechStartedAt = startedAt;
              eventEmitter.emit('playback_started', {
                durationMs: startedAt - (streamingTtsStartedAt ?? unitTtsStartedAt),
                phase: 'tts',
              });
              if (generation === generationRef.current) {
                eventEmitter.emit('animation_start');
                setConversationState('speaking', turnSource);
              }
            },
            onSpeechEnd: (endedAt) => {
              previousStreamingUnitEndedAt = endedAt;
              eventEmitter.emit('tts_unit_playback_completed', {
                phase: 'tts',
                unitIndex: index,
              });
              if (generation !== generationRef.current)
                return;
              scheduleSubtitleClear(generation);
            },
          });
          unitPlaying = false;
          playbackPending = false;
          if (result) recordDelivered(index, text);
          if (generation !== generationRef.current) return null;
          if (pendingCardChange) { abortFetch(); cardChanged(); }
          if (!streamingFirstResult && result)
            streamingFirstResult = result;
          if (result)
            streamingLastResult = result;
          return result;

        });
        void streamingPlaybackQueue.catch(() => { });
      };
      let speechUnitIndex = 0;
      const serverUnitIndexes = new Set<number>();
      const enqueueStreamingSpeechUnit = (index: number, text: string, candidate: ChatResponse) => {
        if (serverUnitIndexes.has(index)) return;
        serverUnitIndexes.add(index);
        // The server defines audible boundaries and signs matching public TTS tickets.
        enqueueSpeechUnit(speechUnitIndex++, text, candidate);
      };
      cardChanged();
      const chatResponse = await dependencies.fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Performer-Turn-Id': eventEmitter.turnId,
          ...(eventEmitter.runId
            ? { 'X-Performer-Run-Id': eventEmitter.runId }
            : {}),
        },
        body: JSON.stringify({
          mode: turnSource === 'autonomous'
            ? 'autonomous'
            : turnSource === 'voice'
              ? 'voice'
              : 'manual',
          ...(messageForRequest === null
            ? {}
            : { message: messageForRequest }),
          history: historyForRequest,
          ...(continuationState ? { cardContinuation: continuationState.continuation } : cardContext.forcedCardId && cardContext.swapRevision !== undefined && acknowledgedCardRevision === cardContext.swapRevision ? { cardContinuation: { deliveredText: '', acknowledgementDelivered: true } } : {}),
          characterIdentity: characterIdentityOverride ?? characterIdentityRef.current,
          programContext: programContextForRequest,
          brainCardIds: cardContext.brainCardIds,
          forcedCardId: cardContext.forcedCardId,
          performanceContext: plan.speech?.llmContext ?? {
            callbackTendency: 0,
            fragmentation: 0,
            semanticBiases: [],
          },
          recentExpressionLevels: recentExpressionLevelsRef.current,
          ...(turnSource === 'autonomous'
            ? {
              topic: autonomousContext?.topic ?? null,
              topicTurns: autonomousContext?.topicTurns ?? 0,
              viewerIntent: autonomousContext?.viewerIntent ?? null,
              viewerTurnsSince: autonomousContext?.viewerTurnsSince ?? 0,
              viewerEngagement: autonomousContext?.viewerEngagement ?? 'available',
              lastSelfUtterance: lastSelfUtteranceRef.current,
              performerState: performerStateContext,
              autonomyCandidate: serializeAutonomyCandidate(autonomyCandidate!),
            }
            : {}),
          streamSpeech: runtimeConfig.streamingSpeechEnabled &&
            (INTERACTIVE_SOURCES.includes(turnSource) || isCardChangeTurn),
          earlySpeechLead: runtimeConfig.earlySpeechLeadEnabled,
        }),
        signal: chatController.signal,
      });
      if (!chatResponse.ok) {
        throw new Error(await readError(chatResponse, 'AI の返答を取得できませんでした。'));
      }
      if (!unitPlaying) cardChanged();
      const contentType = chatResponse.headers.get('content-type') ?? '';
      if (contentType.startsWith('application/x-ndjson')) {
        streamingModeUsed = true;
        await readStreamingChatEvents<ChatResponse>(chatResponse, (event) => {
          if (event.type === 'error')
            throw new Error(event.error);
          if (event.type === 'provider_timing') {
            const eventName = event.milestone === 'start'
              ? 'llm_provider_start'
              : event.milestone === 'first_chunk'
                ? 'llm_provider_first_chunk'
                : 'llm_provider_done';
            eventEmitter.emit(eventName, {
              purpose: event.purpose,
              callIndex: event.callIndex,
              retry: event.retry,
            });
          }
          else if (event.type === 'speech_unit') {
            enqueueStreamingSpeechUnit(event.index, event.text, event.response);
          }
          else if (event.type === 'done') {
            streamedChatPayload = event.response;
          }
        });
        if (!streamedChatPayload) {
          throw new Error('AI のstreaming応答が完了しませんでした。');
        }
      }
      const chatPayload = streamingModeUsed
        ? (streamedChatPayload as unknown as ChatResponse)
        : ((await chatResponse.json()) as ChatResponse);
      eventEmitter.emit('llm_done', {
        durationMs: dependencies.monotonicNow() - llmStartedAt,
        phase: 'llm',
      });
      if (generation !== generationRef.current) {
        emitOwnedResult(executionPlan, 'interrupted');
        emitTerminalEvent('turn_aborted', { reason: 'superseded', phase: 'llm' });
        return { completed: false, decision: null };
      }
      if (abortControllerRef.current === chatController &&
        !streamingSpeechStarted) {
        abortControllerRef.current = null;
      }
      if (typeof chatPayload.text !== 'string') {
        throw new Error('AI の返答形式が正しくありません。');
      }
      const responseText = chatPayload.text.trim();
      if (INTERACTIVE_SOURCES.includes(turnSource)) {
        interactionDecision = readConversationActionDecision(chatPayload.interactionAction, chatPayload.backchannelCue);
      }
      const autonomousDecision = turnSource === 'autonomous'
        ? readAutonomousDecision(chatPayload.externalAction, chatPayload.usedReasonIds, chatPayload.internalDelta, autonomyCandidate!)
        : null;
      const isSpeakingResponse = turnSource === 'manual' ||
        (turnSource === 'voice' &&
          interactionDecision?.action === 'take_floor') ||
        (turnSource === 'autonomous' &&
          autonomousDecision?.externalAction === 'speak');
      const speechAct = chatPayload.speechAct;
      const expressionLevel = chatPayload.expressionLevel;
      if (isSpeakingResponse) {
        if (!isSpeechAct(speechAct) || !isExpressionLevel(expressionLevel)) {
          throw new Error('AI の発話計画形式が正しくありません。');
        }
      }
      else if (speechAct !== null || expressionLevel !== null) {
        throw new Error('非発話応答の発話計画が正しくありません。');
      }
      const internalDelta = turnSource === 'autonomous'
        ? autonomousDecision?.internalDelta ?? { reasonUpdates: [] }
        : chatPayload.internalDelta === undefined
          ? { reasonUpdates: [] }
          : readAutonomyInternalDelta(chatPayload.internalDelta);
      const autonomyDeltaContext = {
        source: turnSource,
        episodeId: autonomyCandidate?.episodeId ??
          autonomyEvidenceContext?.episodeId ??
          null,
        evidenceId: autonomyCandidate?.decisionEvidenceIds.at(-1) ??
          autonomyEvidenceContext?.evidenceId ??
          finalizedVoiceMetadata.segmentId,
        reasonIds: [
          ...(autonomousDecision?.externalAction === 'speak'
            ? autonomousDecision.usedReasonIds
            : autonomyCandidate
              ? []
              : (autonomyEvidenceContext?.reasonIds ?? [])),
        ],
        resolvesReason: turnSource === 'autonomous'
          ? autonomousDecision?.externalAction === 'speak'
          : interactionDecision === null ||
          interactionDecision.action === 'take_floor',
      };
      if ((INTERACTIVE_SOURCES.includes(turnSource) &&
        interactionDecision?.action === 'take_floor' &&
        !responseText) ||
        (interactionDecision !== null &&
          interactionDecision.action !== 'take_floor' &&
          responseText) ||
        (autonomousDecision?.externalAction === 'speak' &&
          autonomousDecision !== null &&
          !responseText) ||
        (autonomousDecision?.externalAction === 'none' && responseText)) {
        throw new Error('AI の返答形式が正しくありません。');
      }
      const activatedCards = readActivatedCards(chatPayload.activatedCards, autonomousDecision !== null || interactionDecision !== null);
      if (isSpeakingResponse && activatedCards.length < 1) {
        throw new Error('AI が主役カードを選びませんでした。');
      }
      if (interactionDecision !== null &&
        interactionDecision.action !== 'take_floor' &&
        activatedCards.length) {
        throw new Error('非発話反応はカードを発動できません。');
      }
      if (autonomousDecision?.externalAction === 'none' && activatedCards.length) {
        throw new Error('沈黙する自律応答はカードを発動できません。');
      }
      const brainCardIds = new Set(cardContext.brainCardIds);
      if (activatedCards.some((id) => !brainCardIds.has(id))) {
        throw new Error('AI が脳内にないカードを発動しました。');
      }
      if (cardContext.forcedCardId &&
        (interactionDecision === null ||
          interactionDecision.action === 'take_floor') &&
        (autonomousDecision === null ||
          autonomousDecision.externalAction === 'speak') &&
        activatedCards[0] !== cardContext.forcedCardId) {
        throw new Error('AI が交換したカードを主役にしませんでした。');
      }
      responseEmotion = normalizeEmotion(chatPayload.emotion);
      if (interactionDecision &&
        interactionDecision.action !== 'take_floor') {
        const reactionPlan = createInteractionReactionPlan(plan);
        activePlanRef.current = plan;
        onPerformancePlanRef.current?.(reactionPlan);
        playback.prepare(reactionPlan);
        if (turnSource === 'voice') {
          floorController.applyFinalized(message ?? '', interactionDecision, finalizedVoiceMetadata);
        }
        setConversationState('idle', null);
        emitOwnedResult(reactionPlan, 'completed', {
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
        emitOwnedResult(executionPlan, 'completed', {
          emotionCue: { emotion: responseEmotion, intensity: 0 },
        });
        emitTerminalEvent('turn_completed', {
          reason: 'no_external_action',
        });
        return { completed: true, decision: autonomousDecision };
      }
      if (textOnlyTurn) { setReply(responseText); }
      onPerformanceCueRef.current?.(executionPlan.planId, {
        emotion: responseEmotion,
        intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
      });
      if (INTERACTIVE_SOURCES.includes(turnSource)) {
        if (turnSource === 'voice' && interactionDecision) {
          const floorTransition = floorController.applyFinalized(message ?? '', interactionDecision, finalizedVoiceMetadata);
          if (floorTransition.action === 'take_floor' && !responseText) {
            throw new Error('TAKE_FLOOR response must contain text.');
          }
          if (floorTransition.committedText) {
            // The user input is already retained; delivery commits the assistant text.
          }
        }
        else if (turnSource === 'manual') {
          // Delivery commits the assistant text.
        }
      }
      if (isMutedRef.current) {
        if (textOnlyTurn) { recordDelivered(0, responseText); onReplyAccepted(activatedCards, cardContext.swapRevision); }
        if (turnSource === 'voice') {
          floorController.release('muted');
        }
        clearSubtitle();
        setConversationState('idle', null);
        emitOwnedResult(executionPlan, 'cancelled', {
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
      if (!streamingSpeechStarted) {
        if (turnSource === 'autonomous' && !isCardChangeTurn) await waitMilliseconds(plan.speech?.delayMs ?? 0);
        if (generation !== generationRef.current) return { completed: false, decision: null };
        cardChanged();
        for (const unit of splitSpeechAtBoundaries(responseText)) enqueueSpeechUnit(speechUnitIndex++, unit, chatPayload);
      }
      if (!unitPlaying) cardChanged();
      if (streamingSpeechStarted) {
        currentPhase = 'tts';
        const playbackResult = await streamingPlaybackQueue;
        if (abortControllerRef.current === chatController) {
          abortControllerRef.current = null;
        }
        if (generation !== generationRef.current || !playbackResult) {
          emitOwnedResult(executionPlan, 'interrupted');
          emitTerminalEvent('turn_aborted', { reason: 'superseded', phase: 'tts' });
          return { completed: false, decision: null };
        }
        const completedAt = dependencies.monotonicNow();
        timeline.record({ kind: 'tts_event', at: dependencies.now(), phase: 'ready', channel: 'server_tts', durationMs: completedAt - (streamingTtsStartedAt ?? completedAt) });
        const firstStreamingResult = streamingFirstResult as PerformancePlaybackResult | null;
        const lastStreamingResult = streamingLastResult as PerformancePlaybackResult | null;
        eventEmitter.emit('tts_completed', {
          durationMs: completedAt - (streamingTtsStartedAt ?? completedAt),
          phase: 'tts',
        });
        eventEmitter.emit('tts_ready', {
          durationMs: completedAt - (streamingTtsStartedAt ?? completedAt),
          phase: 'tts',
        });
        onReplyAccepted(activatedCards, cardContext.swapRevision);
        if (isExpressionLevel(expressionLevel)) recentExpressionLevelsRef.current = [...recentExpressionLevelsRef.current, expressionLevel].slice(-10);
        // Self context is updated only by completed delivery.
        onAutonomyDeltaRef.current?.(internalDelta, autonomyDeltaContext);
        if (turnSource === 'voice')
          floorController.release('response_completed');
        setConversationState('idle', null);
        emitOwnedResult(executionPlan, 'completed', {
          interactionAction: interactionDecision?.action ??
            (autonomousDecision
              ? 'take_floor'
              : executionPlan.actionDecision?.action),
          spokenText: deliveredText,
          emotionCue: {
            emotion: responseEmotion,
            intensity: responseEmotion === 'neutral' ? 0.25 : 0.7,
          },
          motionStartedAt: firstStreamingResult?.motionStartedAt ?? motionStartedAt,
          speechStartedAt: firstStreamingResult?.speechStartedAt ?? speechStartedAt,
          speechEndedAt: lastStreamingResult?.speechEndedAt ?? playbackResult.speechEndedAt,
        });
        emitTerminalEvent('turn_completed', {
          ...(interactionDecision?.action
            ? { interactionAction: interactionDecision.action }
            : autonomousDecision
              ? { interactionAction: 'take_floor' }
              : executionPlan.actionDecision?.action
                ? { interactionAction: executionPlan.actionDecision.action }
                : {}),
        });
        return { completed: true, decision: autonomousDecision };
      }
      throw new Error('返答に再生可能な発話がありません。');
    }
    catch (caughtError) {
      if (abortControllerRef.current === requestController) {
        abortControllerRef.current = null;
      }
      if (generation !== generationRef.current) {
        emitOwnedResult(executionPlan, 'interrupted');
        emitTerminalEvent('turn_aborted', {
          reason: 'superseded',
          phase: currentPhase,
        });
        return { completed: false, decision: null };
      }
      if (pendingCardChange) {
        if (unitPlaying) { try { await streamingPlaybackQueue; } catch { /* The replacement owns the remaining units. */ } }
        if (generation !== generationRef.current) return { completed: false, decision: null };
        abortFetch();
        emitTerminalEvent('turn_aborted', { reason: 'card_change' });
        if (humanSpeechPending) {
          emitOwnedResult(executionPlan, 'interrupted');
          setConversationState('idle', null);
          return { completed: false, decision: null };
        }
        // End only the old performance. The pending card belongs to the continuation.
        emitOwnedResult(executionPlan, 'interrupted');
        setConversationState('idle', null);
        const replacementCards = pendingCardChange as ChatCardContext;
        return { completed: false, decision: null, cardChange: {
          cards: replacementCards, generation, historyTurnId, nextUnitIndex, history: historyForRequest,
          continuation: { deliveredText: (deliveredText || continuationState?.continuation.deliveredText || '').slice(-4000), acknowledgementDelivered: replacementCards.swapRevision !== undefined && replacementCards.swapRevision === acknowledgedCardRevision },
        } };
      }
      if (isAbortError(caughtError)) {
        if (turnSource === 'voice') {
          floorController.release('aborted');
        }
        clearSubtitle();
        setConversationState('idle', null);
        emitOwnedResult(executionPlan, 'cancelled', { spokenText: deliveredText });
        emitTerminalEvent('turn_aborted', { reason: 'aborted' });
        return {
          completed: INTERACTIVE_SOURCES.includes(turnSource) &&
            isMutedRef.current,
          decision: null,
        };
      }
      if (turnSource === 'voice') {
        floorController.reset('take_floor_failed');
      }
      clearSubtitle();
      setError(caughtError instanceof Error
        ? caughtError.message
        : '会話処理に失敗しました。');
      setConversationState('error', null);
      requestController?.abort();
      playback.stop();
      emitOwnedResult(executionPlan, 'failed', { spokenText: deliveredText });
      emitTerminalEvent('turn_failed', {
        reason: 'request_failed',
        phase: currentPhase,
      });
      return { completed: false, decision: null };
    }
    finally {
      releaseAudioCapture?.();
      if (activePresentationPlanIdRef.current === executionPlan.planId) {
        activePresentationPlanIdRef.current = null;
        onReplyPresentationEndRef.current?.(executionPlan.planId);
      }
      if (generation === generationRef.current && activeTurnControlRef.current === turnControl && turnSource === 'voice' && floorController.getState().floorOwner === 'vayria') {
        floorController.release('turn_ended');
      }
      if (activeTurnControlRef.current === turnControl) {
        activeTurnControlRef.current = null;
      }
    }
  };
  const runTurn = async (...args: Parameters<typeof processTurn>): Promise<ProcessTurnResult> => {
    let result = await processTurn(...args);
    while (result.cardChange && result.cardChange.generation === generationRef.current) {
      const change = result.cardChange;
      args[2] = change.cards;
      const trigger: PerformerTrigger | null = args[1] !== null
        ? { kind: 'viewer_message', text: args[1] }
        : args[9] ? { kind: 'autonomous_candidate', episodeId: args[9].episodeId, reasonIds: args[9].reasons.map(reason => reason.id) } : null;
      if (trigger) args[5] = options.createCardContinuationPlan?.(trigger) ?? args[5];
      args[8] = { ...(args[8] ?? programContextRef.current), phase: 'after_card_change' };
      args[11] = change;
      result = await processTurn(...args);
    }
    return result;
  };
  const sendManual = async (message: string, cardContext: ChatCardContext, onReplyAccepted: (activatedCardIds: string[], swapRevision?: number) => void, plan: PerformancePlan, characterIdentityOverride?: CharacterIdentity, programContextOverride?: ProgramContext, autonomyEvidenceContext?: AutonomyEvidenceContext) => (await runTurn('manual', message, cardContext, onReplyAccepted, null, plan, undefined, characterIdentityOverride, programContextOverride, undefined, autonomyEvidenceContext ?? null)).completed;
  const sendVoice = async (message: string, cardContext: ChatCardContext, onReplyAccepted: (activatedCardIds: string[], swapRevision?: number) => void, plan: PerformancePlan, voiceMetadata?: VoiceTurnMetadata, characterIdentityOverride?: CharacterIdentity, programContextOverride?: ProgramContext, autonomyEvidenceContext?: AutonomyEvidenceContext) => (await runTurn('voice', message, cardContext, onReplyAccepted, null, plan, voiceMetadata, characterIdentityOverride, programContextOverride, undefined, autonomyEvidenceContext ?? null)).completed;
  const sendAutonomous = async (cardContext: ChatCardContext, autonomousContext: AutonomousContext, onReplyAccepted: (activatedCardIds: string[], swapRevision?: number) => void, plan: PerformancePlan, programContextOverride?: ProgramContext, autonomyCandidate?: AutonomyCandidate) => {
    const result = await runTurn('autonomous', null, cardContext, onReplyAccepted, autonomousContext, plan, undefined, undefined, programContextOverride, autonomyCandidate ?? null, null);
    return result.completed ? result.decision : null;
  };
  const makeSnapshot = () => ({
    reply, isSubtitleVisible, error, status, source,
    isBusy: ACTIVE_STATUSES.includes(status),
    isManualBusy: ACTIVE_STATUSES.includes(status) && INTERACTIVE_SOURCES.includes(source ?? 'manual')
  });
  let snapshot = makeSnapshot();
  function publish() { snapshot = makeSnapshot(); for (const listener of listeners) listener(); }
  const updateOptions = (next: ConversationOptions) => {
    const muteChanged = isMuted !== (next.isMuted ?? false);
    options = next;
    isMuted = options.isMuted ?? false;
    isExhibitionMode = options.isExhibitionMode ?? false;

    onPerformanceCueRef.current = options.onPerformanceCue;
    onPerformancePlanRef.current = options.onPerformancePlan;
    onPerformanceResultRef.current = options.onPerformanceResult;
    onInteractionActionRef.current = options.onInteractionAction;
    onAutonomyDeltaRef.current = options.onAutonomyDelta;
    onReplyPresentationStartRef.current = options.onReplyPresentationStart;
    onReplyPresentationEndRef.current = options.onReplyPresentationEnd;
    timeline.setListener(options.onInteractionTimelineEvent);


    characterIdentityRef.current =
      options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY;
    participationController.setCharacterIdentity(characterIdentityRef.current);


    participationController.setContext(options.conversationContext);


    programContextRef.current =
      options.programContext ?? DEFAULT_PROGRAM_CONTEXT;


    getPerformerStateContextRef.current = options.getPerformerStateContext;

    if (muteChanged) {
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
    }
  };
  const updatePlayback = (next: PerformancePlayback) => {
    if (next === playback) return;
    finishActivePlanAsCancelled();
    invalidateCurrentTurn(true);
    clearSubtitle();
    playback = next;
    setConversationState('idle', null);
  };
  const dispose = () => {
    generationRef.current += 1;
    abortFetch();
    clearSubtitleTimer();
    activePlanRef.current = null;
    playback.stop(); floorController.reset('disposed'); listeners.clear();
  };
  updateOptions(options);
  return {
    getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, updateOptions, updatePlayback, dispose,
    changeCardsDuringTurn, cancelAutonomous, clearSubtitle, evaluateVoiceParticipation, interruptCurrentTurn, previewVoiceMessage, recordVoiceSignal, resetConversation, sendAutonomous, sendManual, sendVoice
  };
}
