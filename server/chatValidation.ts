import { isCardContinuation, MAX_SPEECH_UNIT_INDEX } from '../src/conversation/cardContinuation.js';
import {
  EMOTIONS,
  normalizeEmotion,
  type AssistantResponse,
  type Emotion
} from '../src/character/emotion.js';
import {
  DEFAULT_CHARACTER_IDENTITY,
  parseCharacterIdentity,
  type CharacterIdentity
} from '../src/character/identity.js';
import {
  isViewerEngagement,
  isViewerIntent
} from '../src/conversation/autonomousContext.js';
import {
  MAX_AUTONOMY_CONTENT_LENGTH,
  MAX_CANDIDATE_REASONS,
  MAX_DECISION_EVIDENCE_IDS,
  MAX_REASON_UPDATES_PER_DELTA,
  isAutonomyDeferCause,
  isAutonomyExternalAction,
  isAutonomyWakeCondition,
  isCandidateReasonKind,
  type AutonomyCandidate,
  type AutonomyExternalAction,
  type AutonomyInternalDelta,
  type CandidateReason,
  type ReasonUpdate
} from '../src/conversation/autonomyState.js';
import {
  AUTONOMY_TIMING_MODES,
  AUTONOMY_TURN_GATE_BLOCK_REASONS,
  AUTONOMY_TURN_GATE_EVENTS,
  AUTONOMY_TURN_GATE_EXTERNAL_EVENTS,
  AUTONOMY_TURN_GATE_PHASES,
  AUTONOMY_TURN_GATE_TRANSITIONS,
  type AutonomyTurnGateTelemetry,
} from '../src/conversation/autonomyTurnGate.js';
import {
  DEFAULT_PROGRAM_CONTEXT,
  isProgramContext
} from '../src/conversation/programContext.js';
import {
  isExpressionLevel,
  isSpeechAct,
  isWithinExpressionBudget,
  type ExpressionLevel,
  type SpeechAct
} from '../src/conversation/utterancePlan.js';
import {
  isActionCommitmentMessage,
  isContentBearingVoiceMessage,
  isDefiniteBackchannelMessage,
  isDefiniteQuestionMessage,
  isDirectActionRequestMessage,
  isMetaOnlyActionResponse
} from '../src/performer/runtime.js';
import {
  ATTENTION_TARGETS,
  PERFORMER_PHASES,
  isConversationAction,
  isConversationActionDecision,
  type ConversationActionDecision,
  type PerformerStateContext,
  type WeightedSemanticCue,
} from '../src/performer/types.js';
import { isPlaycheckRunId } from '../src/playcheck.js';
import {
  isVoiceBackchannelCue,
  isVoiceInteractionAction,
  isVoiceInteractionDecision,
  type VoiceBackchannelCue,
  type VoiceInteractionAction,
  type VoiceInteractionDecision
} from '../src/voice/voiceInteraction.js';
import { AUTONOMY_DELTA_OPERATIONS, AUTONOMY_REASON_UPDATE_FIELDS, BRAIN_CARD_COUNT, CARD_BY_ID, CONVERSATION_EVENTS, CardContractError, ConversationPolicyContractError, INTERACTIVE_POLICY_ACTIONS, MAX_ACTIVATED_CARDS, MAX_EVENT_ID_LIST_LENGTH, MAX_EVENT_REASON_LENGTH, MAX_EVENT_TURN_ID_LENGTH, MAX_HISTORY_ITEMS, MAX_TEXT_LENGTH, MAX_TOPIC_LENGTH, MAX_TOPIC_TURNS, MAX_VIEWER_TURNS_SINCE, PLAYBACK_GESTURE_REASONS, RequestError, SAFE_EVENT_ID_PATTERN, VoicePolicyContractError, normalizeVoiceAssistantResponseDecision, type CardAssistantResponse, type CardPreviewRequestPayload, type ChatHistoryItem, type ChatMode, type ChatRequestPayload, type ClientConversationEvent, type ConversationEventName, type PerformanceContextPayload } from './localApiSupport.js';

export function readSafeEventId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_EVENT_ID_PATTERN.test(value)) {
    throw new RequestError(`${field} is invalid.`, 400);
  }
  return value;
}

export function readNonNegativeEventInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new RequestError(`${field} must be a non-negative integer.`, 400);
  }
  return value;
}

export function readSafeEventIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVENT_ID_LIST_LENGTH) {
    throw new RequestError(`${field} must be a bounded string list.`, 400);
  }
  const values = value.map((item) => readSafeEventId(item, field));
  if (new Set(values).size !== values.length) {
    throw new RequestError(`${field} must contain unique IDs.`, 400);
  }
  return values;
}

export function readConversationEvent(payload: unknown): ClientConversationEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Event body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    'at',
    'audioContextState',
    'audioSourceKind',
    'bufferedDurationMs',
    'elapsedMs',
    'event',
    'source',
    'turnId',
    'durationMs',
    'emotion',
    'firstChunkBytes',
    'firstChunkIntervalMs',
    'phase',
    'playbackRoute',
    'primingOutcome',
    'primingTargetMs',
    'primingWaitMs',
    'reason',
    'sampleRateHz',
    'interactionAction',
    'purpose',
    'callIndex',
    'retry',
    'unitIndex',
    'runId',
    'gateEvent',
    'gatePhase',
    'transition',
    'blockedBy',
    'externalEvent',
    'candidateEpisodeId',
    'candidateReasonIds',
    'candidateEvidenceIds',
    'usedReasonIds',
    'internalDeltaOperations',
    'affectedReasonIds',
    'createdReasonIds',
    'resolvedReasonIds',
    'externalAction',
    'nextEligibleAt',
    'delayMs',
    'timingMode',
    'elapsedSilenceMs',
    'readiness',
    'threshold',
    'opportunityOutcome',
    'sessionGeneration',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError('Event body contains an unsupported field.', 400);
  }

  const turnId = record.turnId;
  if (
    typeof turnId !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(turnId) ||
    turnId.length > MAX_EVENT_TURN_ID_LENGTH
  ) {
    throw new RequestError('turnId is invalid.', 400);
  }

  const source = record.source;
  if (source !== 'manual' && source !== 'voice' && source !== 'autonomous') {
    throw new RequestError('source must be manual, voice, or autonomous.', 400);
  }

  const event = record.event;
  if (
    typeof event !== 'string' ||
    !(CONVERSATION_EVENTS as readonly string[]).includes(event)
  ) {
    throw new RequestError('event is invalid.', 400);
  }
  const playbackStartupFields = [
    'audioContextState',
    'audioSourceKind',
    'bufferedDurationMs',
    'firstChunkBytes',
    'firstChunkIntervalMs',
    'playbackRoute',
    'primingOutcome',
    'primingTargetMs',
    'primingWaitMs',
    'sampleRateHz',
  ] as const;
  const hasPlaybackStartupFields = playbackStartupFields.some(
    (field) => record[field] !== undefined,
  );
  if (event !== 'playback_startup' && hasPlaybackStartupFields) {
    throw new RequestError(
      'Playback startup fields are only valid for playback_startup events.',
      400,
    );
  }
  if (event === 'playback_startup' && source !== 'voice') {
    throw new RequestError('playback_startup events must use the voice source.', 400);
  }
  if (
    event === 'playback_gesture_required' &&
    (typeof record.reason !== 'string' ||
      !(PLAYBACK_GESTURE_REASONS as readonly string[]).includes(record.reason))
  ) {
    throw new RequestError('playback gesture reason is invalid.', 400);
  }

  const gateFields = [
    'gateEvent',
    'gatePhase',
    'transition',
    'blockedBy',
    'externalEvent',
    'candidateEpisodeId',
    'candidateReasonIds',
    'candidateEvidenceIds',
    'usedReasonIds',
    'internalDeltaOperations',
    'affectedReasonIds',
    'externalAction',
    'nextEligibleAt',
    'delayMs',
    'timingMode',
    'elapsedSilenceMs',
    'readiness',
    'threshold',
    'opportunityOutcome',
    'sessionGeneration',
  ];
  const hasGateFields = gateFields.some((field) => record[field] !== undefined);
  if (event !== 'autonomy_gate' && hasGateFields) {
    throw new RequestError(
      'Autonomy gate fields are only valid for autonomy_gate events.',
      400,
    );
  }
  if (event === 'autonomy_gate') {
    if (source !== 'autonomous') {
      throw new RequestError(
        'autonomy_gate events must use the autonomous source.',
        400,
      );
    }
    if (
      typeof record.gateEvent !== 'string' ||
      !(AUTONOMY_TURN_GATE_EVENTS as readonly string[]).includes(
        record.gateEvent,
      )
    ) {
      throw new RequestError('gateEvent is invalid.', 400);
    }
    if (
      typeof record.gatePhase !== 'string' ||
      !(AUTONOMY_TURN_GATE_PHASES as readonly string[]).includes(
        record.gatePhase,
      )
    ) {
      throw new RequestError('gatePhase is invalid.', 400);
    }
  }

  const at = record.at;
  if (
    typeof at !== 'string' ||
    !Number.isFinite(Date.parse(at))
  ) {
    throw new RequestError('at must be a valid timestamp.', 400);
  }

  const elapsedMs = record.elapsedMs;
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0
  ) {
    throw new RequestError('elapsedMs must be a non-negative integer.', 400);
  }

  const eventPayload: ClientConversationEvent = {
    at,
    elapsedMs,
    event: event as ConversationEventName,
    source,
    turnId,
  };

  const providerTimingFields = ['purpose', 'callIndex', 'retry'] as const;
  const isProviderTimingEvent =
    event === 'llm_provider_start' ||
    event === 'llm_provider_first_chunk' ||
    event === 'llm_provider_done';
  if (
    !isProviderTimingEvent &&
    providerTimingFields.some((field) => record[field] !== undefined)
  ) {
    throw new RequestError(
      'Provider timing fields are only valid for provider timing events.',
      400,
    );
  }
  if (isProviderTimingEvent) {
    if (
      record.purpose !== 'conversation-policy' &&
      record.purpose !== 'response-generation' &&
      record.purpose !== 'card-preview'
    ) {
      throw new RequestError('purpose is invalid.', 400);
    }
    eventPayload.purpose = record.purpose;
    eventPayload.callIndex = readNonNegativeEventInteger(
      record.callIndex,
      'callIndex',
    );
    if (eventPayload.callIndex === 0) {
      throw new RequestError('callIndex must be positive.', 400);
    }
    eventPayload.retry = readNonNegativeEventInteger(record.retry, 'retry');
  }

  const unitEventNames = [
    'tts_unit_start',
    'tts_unit_audio_ready',
    'tts_unit_playback_started',
    'tts_unit_playback_completed',
    'tts_queue_gap',
  ] as const;
  const isUnitEvent = (unitEventNames as readonly string[]).includes(event);
  if (!isUnitEvent && record.unitIndex !== undefined) {
    throw new RequestError(
      'unitIndex is only valid for unit TTS events.',
      400,
    );
  }
  if (isUnitEvent) {
    eventPayload.unitIndex = readNonNegativeEventInteger(
      record.unitIndex,
      'unitIndex',
    );
    if (eventPayload.unitIndex > MAX_SPEECH_UNIT_INDEX) {
      throw new RequestError(`unitIndex must be between 0 and ${MAX_SPEECH_UNIT_INDEX}.`, 400);
    }
  }

  if (event === 'playback_startup') {
    if (record.playbackRoute !== 'conversation') {
      throw new RequestError('playbackRoute is invalid.', 400);
    }
    if (record.audioSourceKind !== 'buffer' && record.audioSourceKind !== 'stream') {
      throw new RequestError('audioSourceKind is invalid.', 400);
    }
    if (
      record.audioContextState !== 'closed' &&
      record.audioContextState !== 'running' &&
      record.audioContextState !== 'suspended'
    ) {
      throw new RequestError('audioContextState is invalid.', 400);
    }
    if (
      record.primingOutcome !== 'cancelled' &&
      record.primingOutcome !== 'complete' &&
      record.primingOutcome !== 'disabled' &&
      record.primingOutcome !== 'target' &&
      record.primingOutcome !== 'timeout'
    ) {
      throw new RequestError('primingOutcome is invalid.', 400);
    }
    for (const field of [
      'bufferedDurationMs',
      'primingTargetMs',
      'primingWaitMs',
      'sampleRateHz',
    ] as const) {
      eventPayload[field] = readNonNegativeEventInteger(record[field], field);
    }
    for (const field of ['firstChunkBytes', 'firstChunkIntervalMs'] as const) {
      if (record[field] !== undefined) {
        eventPayload[field] = readNonNegativeEventInteger(record[field], field);
      }
    }
    eventPayload.playbackRoute = record.playbackRoute;
    eventPayload.audioSourceKind = record.audioSourceKind;
    eventPayload.audioContextState = record.audioContextState;
    eventPayload.primingOutcome = record.primingOutcome;
  }

  if (record.gateEvent !== undefined) {
    eventPayload.gateEvent = record.gateEvent as AutonomyTurnGateTelemetry['gateEvent'];
  }
  if (record.gatePhase !== undefined) {
    eventPayload.gatePhase = record.gatePhase as AutonomyTurnGateTelemetry['gatePhase'];
  }
  if (record.transition !== undefined) {
    if (
      typeof record.transition !== 'string' ||
      !(AUTONOMY_TURN_GATE_TRANSITIONS as readonly string[]).includes(
        record.transition,
      )
    ) {
      throw new RequestError('transition is invalid.', 400);
    }
    eventPayload.transition = record.transition as AutonomyTurnGateTelemetry['transition'];
  }
  if (record.blockedBy !== undefined) {
    if (
      typeof record.blockedBy !== 'string' ||
      !(AUTONOMY_TURN_GATE_BLOCK_REASONS as readonly string[]).includes(
        record.blockedBy,
      )
    ) {
      throw new RequestError('blockedBy is invalid.', 400);
    }
    eventPayload.blockedBy = record.blockedBy as AutonomyTurnGateTelemetry['blockedBy'];
  }
  if (record.externalEvent !== undefined) {
    if (
      typeof record.externalEvent !== 'string' ||
      !(AUTONOMY_TURN_GATE_EXTERNAL_EVENTS as readonly string[]).includes(
        record.externalEvent,
      )
    ) {
      throw new RequestError('externalEvent is invalid.', 400);
    }
    eventPayload.externalEvent = record.externalEvent as AutonomyTurnGateTelemetry['externalEvent'];
  }
  if (record.candidateEpisodeId !== undefined) {
    eventPayload.candidateEpisodeId = readSafeEventId(
      record.candidateEpisodeId,
      'candidateEpisodeId',
    );
  }
  for (const field of [
    'candidateReasonIds',
    'candidateEvidenceIds',
    'usedReasonIds',
    'affectedReasonIds',
    'createdReasonIds',
    'resolvedReasonIds',
  ] as const) {
    if (record[field] !== undefined) {
      eventPayload[field] = readSafeEventIdList(record[field], field);
    }
  }
  if (record.internalDeltaOperations !== undefined) {
    const operations = readSafeEventIdList(
      record.internalDeltaOperations,
      'internalDeltaOperations',
    );
    if (
      operations.some(
        (operation) =>
          !(AUTONOMY_DELTA_OPERATIONS as readonly string[]).includes(operation),
      )
    ) {
      throw new RequestError('internalDeltaOperations is invalid.', 400);
    }
    eventPayload.internalDeltaOperations = operations;
  }
  if (record.externalAction !== undefined) {
    if (record.externalAction !== 'speak' && record.externalAction !== 'none') {
      throw new RequestError('externalAction is invalid.', 400);
    }
    eventPayload.externalAction = record.externalAction;
  }
  for (const field of ['nextEligibleAt', 'delayMs'] as const) {
    if (record[field] === undefined) continue;
    const value = record[field];
    if (field === 'nextEligibleAt' && value === null) {
      eventPayload.nextEligibleAt = null;
      continue;
    }
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new RequestError(`${field} is invalid.`, 400);
    }
    eventPayload[field] = value;
  }
  if (record.timingMode !== undefined) {
    if (
      typeof record.timingMode !== 'string' ||
      !(AUTONOMY_TIMING_MODES as readonly string[]).includes(record.timingMode)
    ) {
      throw new RequestError('timingMode is invalid.', 400);
    }
    eventPayload.timingMode = record.timingMode as AutonomyTurnGateTelemetry['timingMode'];
  }
  for (const field of ['readiness', 'threshold'] as const) {
    if (record[field] === undefined) continue;
    const value = record[field];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new RequestError(`${field} is invalid.`, 400);
    }
    eventPayload[field] = value;
  }
  for (const field of ['elapsedSilenceMs', 'sessionGeneration'] as const) {
    if (record[field] === undefined) continue;
    const value = record[field];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new RequestError(`${field} is invalid.`, 400);
    }
    eventPayload[field] = value;
  }
  if (record.opportunityOutcome !== undefined) {
    if (
      record.opportunityOutcome !== 'fired' &&
      record.opportunityOutcome !== 'skipped'
    ) {
      throw new RequestError('opportunityOutcome is invalid.', 400);
    }
    eventPayload.opportunityOutcome = record.opportunityOutcome;
  }

  if (record.runId !== undefined) {
    if (!isPlaycheckRunId(record.runId)) {
      throw new RequestError('runId is invalid.', 400);
    }
    eventPayload.runId = record.runId;
  }

  if (record.durationMs !== undefined) {
    if (
      typeof record.durationMs !== 'number' ||
      !Number.isSafeInteger(record.durationMs) ||
      record.durationMs < 0
    ) {
      throw new RequestError('durationMs must be a non-negative integer.', 400);
    }
    eventPayload.durationMs = record.durationMs;
  }

  if (record.emotion !== undefined) {
    if (
      typeof record.emotion !== 'string' ||
      !(EMOTIONS as readonly string[]).includes(record.emotion)
    ) {
      throw new RequestError('emotion is invalid.', 400);
    }
    eventPayload.emotion = record.emotion as Emotion;
  }

  if (record.phase !== undefined) {
    if (record.phase !== 'llm' && record.phase !== 'tts') {
      throw new RequestError('phase is invalid.', 400);
    }
    eventPayload.phase = record.phase;
  }

  if (record.reason !== undefined) {
    if (
      typeof record.reason !== 'string' ||
      record.reason.length > MAX_EVENT_REASON_LENGTH
    ) {
      throw new RequestError('reason is invalid.', 400);
    }
    eventPayload.reason = record.reason;
  }

  if (record.interactionAction !== undefined) {
    if (!isConversationAction(record.interactionAction)) {
      throw new RequestError('interactionAction is invalid.', 400);
    }
    eventPayload.interactionAction = record.interactionAction;
  }

  return eventPayload;
}

function readWeightedSemanticCues(value: unknown): WeightedSemanticCue[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new RequestError('performanceContext format is invalid.', 400);
  }

  const cues = new Map<string, number>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new RequestError('performanceContext format is invalid.', 400);
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== 'cue' && key !== 'weight')
    ) {
      throw new RequestError('performanceContext format is invalid.', 400);
    }
    const cue = typeof record.cue === 'string' ? record.cue.trim() : '';
    const weight = record.weight;
    if (
      cue.length < 1 ||
      cue.length > 200 ||
      typeof weight !== 'number' ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight > 1
    ) {
      throw new RequestError('performanceContext format is invalid.', 400);
    }
    cues.set(cue, Math.max(cues.get(cue) ?? 0, weight));
  }

  return [...cues.entries()]
    .map(([cue, weight]) => ({ cue, weight }))
    .sort(
      (left, right) =>
        right.weight - left.weight || left.cue.localeCompare(right.cue),
    );
}

function readPerformanceContext(value: unknown): PerformanceContextPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('performanceContext must be an object.', 400);
  }
  const context = value as Record<string, unknown>;
  if (
    Object.keys(context).some(
      (key) =>
        key !== 'callbackTendency' &&
        key !== 'fragmentation' &&
        key !== 'semanticBiases',
    )
  ) {
    throw new RequestError(
      'performanceContext contains an unsupported field.',
      400,
    );
  }
  const callbackTendency = context.callbackTendency;
  const fragmentation = context.fragmentation;
  if (
    typeof callbackTendency !== 'number' ||
    !Number.isFinite(callbackTendency) ||
    callbackTendency < 0 ||
    callbackTendency > 1 ||
    typeof fragmentation !== 'number' ||
    !Number.isFinite(fragmentation) ||
    fragmentation < 0 ||
    fragmentation > 1
  ) {
    throw new RequestError('performanceContext format is invalid.', 400);
  }
  return {
    callbackTendency,
    fragmentation,
    semanticBiases: readWeightedSemanticCues(context.semanticBiases),
  };
}

export function readCardPreviewRequest(
  payload: unknown,
): CardPreviewRequestPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set(['cardId', 'performanceContext']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError(
      'Request body contains an unsupported card preview field.',
      400,
    );
  }

  const cardId = record.cardId;
  if (typeof cardId !== 'string' || !CARD_BY_ID.has(cardId)) {
    throw new RequestError('cardId must be a known card ID.', 400);
  }

  return {
    cardId,
    performanceContext: readPerformanceContext(record.performanceContext),
  };
}

export function readPerformerStateContext(
  value: unknown,
): PerformerStateContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('performerState must be an object or null.', 400);
  }

  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'phase',
    'energy',
    'emotion',
    'emotionActivation',
    'attentionTarget',
    'attentionStrength',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError(
      'performerState contains an unsupported field.',
      400,
    );
  }

  const phase = record.phase;
  const energy = record.energy;
  const emotion = record.emotion;
  const emotionActivation = record.emotionActivation;
  const attentionTarget = record.attentionTarget;
  const attentionStrength = record.attentionStrength;
  if (
    typeof phase !== 'string' ||
    !(PERFORMER_PHASES as readonly string[]).includes(phase) ||
    typeof energy !== 'number' ||
    !Number.isFinite(energy) ||
    energy < 0 ||
    energy > 1 ||
    typeof emotion !== 'string' ||
    !(EMOTIONS as readonly string[]).includes(emotion) ||
    typeof emotionActivation !== 'number' ||
    !Number.isFinite(emotionActivation) ||
    emotionActivation < 0 ||
    emotionActivation > 1 ||
    typeof attentionTarget !== 'string' ||
    !(ATTENTION_TARGETS as readonly string[]).includes(attentionTarget) ||
    typeof attentionStrength !== 'number' ||
    !Number.isFinite(attentionStrength) ||
    attentionStrength < 0 ||
    attentionStrength > 1
  ) {
    throw new RequestError('performerState format is invalid.', 400);
  }

  return {
    phase: phase as PerformerStateContext['phase'],
    energy,
    emotion: emotion as PerformerStateContext['emotion'],
    emotionActivation,
    attentionTarget: attentionTarget as PerformerStateContext['attentionTarget'],
    attentionStrength,
  };
}

export function readChatRequest(payload: unknown): ChatRequestPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    'cardContinuation',
    'greeting',
    'mode',
    'message',
    'characterIdentity',
    'history',
    'brainCardIds',
    'forcedCardId',
    'topic',
    'topicTurns',
    'viewerIntent',
    'viewerTurnsSince',
    'viewerEngagement',
    'programContext',
    'performerState',
    'lastSelfUtterance',
    'performanceContext',
    'autonomyCandidate',
    'streamSpeech',
    'earlySpeechLead',
    'recentExpressionLevels',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError(
      'Request body contains an unsupported chat field.',
      400,
    );
  }

  const mode = record.mode;
  if (record.greeting !== undefined && (record.greeting !== true || mode !== 'manual')) {
    throw new RequestError('greeting must be true and requires manual mode.', 400);
  }
  if (mode !== 'manual' && mode !== 'voice' && mode !== 'autonomous') {
    throw new RequestError('mode must be manual, voice, or autonomous.', 400);
  }
  if (record.streamSpeech !== undefined && typeof record.streamSpeech !== 'boolean') {
    throw new RequestError('streamSpeech must be a boolean.', 400);
  }
  const streamSpeechRequested = record.streamSpeech === true;
  if (
    record.earlySpeechLead !== undefined &&
    typeof record.earlySpeechLead !== 'boolean'
  ) {
    throw new RequestError('earlySpeechLead must be a boolean.', 400);
  }

  const characterIdentityValue = record.characterIdentity;
  const characterIdentity =
    characterIdentityValue === undefined
      ? { ...DEFAULT_CHARACTER_IDENTITY, aliases: [] }
      : parseCharacterIdentity(characterIdentityValue);
  if (!characterIdentity) {
    throw new RequestError('characterIdentity format is invalid.', 400);
  }

  const message = record.message;
  let normalizedMessage: string | null = null;
  if (mode === 'manual' || mode === 'voice') {
    if (typeof message !== 'string' || !message.trim()) {
      throw new RequestError(
        `${mode} message must be non-empty text.`,
        400,
      );
    }
    normalizedMessage = message.trim();
    if (normalizedMessage.length > MAX_TEXT_LENGTH) {
      throw new RequestError(
        `message must be ${MAX_TEXT_LENGTH} characters or fewer.`,
        400,
      );
    }
  } else if (message !== undefined) {
    throw new RequestError(
      'autonomous requests must not contain message.',
      400,
    );
  }

  const lastSelfUtteranceValue = record.lastSelfUtterance;
  if (
    lastSelfUtteranceValue !== undefined &&
    lastSelfUtteranceValue !== null &&
    typeof lastSelfUtteranceValue !== 'string'
  ) {
    throw new RequestError(
      'lastSelfUtterance must be text or null.',
      400,
    );
  }
  const lastSelfUtterance =
    typeof lastSelfUtteranceValue === 'string'
      ? lastSelfUtteranceValue.trim()
      : null;
  if (
    lastSelfUtterance &&
    lastSelfUtterance.length > MAX_TEXT_LENGTH
  ) {
    throw new RequestError(
      `lastSelfUtterance must be ${MAX_TEXT_LENGTH} characters or fewer.`,
      400,
    );
  }

  const history = record.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) {
    throw new RequestError(
      `history must contain at most ${MAX_HISTORY_ITEMS} items.`,
      400,
    );
  }
  const normalizedHistory = history.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RequestError('history items must be objects.', 400);
    }
    const historyItem = item as Record<string, unknown>;
    if (
      Object.keys(historyItem).length !== 2 ||
      (historyItem.role !== 'user' && historyItem.role !== 'assistant') ||
      typeof historyItem.content !== 'string' ||
      !historyItem.content.trim()
    ) {
      throw new RequestError('history item format is invalid.', 400);
    }
    const content = historyItem.content.trim();
    if (content.length > MAX_TEXT_LENGTH) {
      throw new RequestError(
        `history content must be ${MAX_TEXT_LENGTH} characters or fewer.`,
        400,
      );
    }
    return { role: historyItem.role, content } as ChatHistoryItem;
  });

  const brainCardIds = record.brainCardIds;
  if (
    !Array.isArray(brainCardIds) ||
    brainCardIds.length !== BRAIN_CARD_COUNT ||
    !brainCardIds.every((id): id is string => typeof id === 'string')
  ) {
    throw new RequestError(
      `brainCardIds must contain exactly ${BRAIN_CARD_COUNT} card IDs.`,
      400,
    );
  }
  if (new Set(brainCardIds).size !== BRAIN_CARD_COUNT) {
    throw new RequestError('brainCardIds must not contain duplicates.', 400);
  }
  if (brainCardIds.some((id) => !CARD_BY_ID.has(id))) {
    throw new RequestError('brainCardIds contains an unknown card ID.', 400);
  }

  const forcedCardId = record.forcedCardId;
  if (forcedCardId !== null && typeof forcedCardId !== 'string') {
    throw new RequestError('forcedCardId must be a card ID or null.', 400);
  }
  if (forcedCardId !== null && !brainCardIds.includes(forcedCardId)) {
    throw new RequestError(
      'forcedCardId must be one of the current brainCardIds.',
      400,
    );
  }

  const recentExpressionLevelsValue = record.recentExpressionLevels;
  if (
    !Array.isArray(recentExpressionLevelsValue) ||
    recentExpressionLevelsValue.length > 10 ||
    !recentExpressionLevelsValue.every(isExpressionLevel)
  ) {
    throw new RequestError(
      'recentExpressionLevels must contain at most 10 expression levels.',
      400,
    );
  }
  const recentExpressionLevels = [...recentExpressionLevelsValue];

  const topicValue = record.topic;
  if (
    topicValue !== undefined &&
    topicValue !== null &&
    typeof topicValue !== 'string'
  ) {
    throw new RequestError('topic must be a string or null.', 400);
  }
  const topic =
    typeof topicValue === 'string' ? topicValue.trim() || null : null;
  if (topic && topic.length > MAX_TOPIC_LENGTH) {
    throw new RequestError(
      `topic must be ${MAX_TOPIC_LENGTH} characters or fewer.`,
      400,
    );
  }

  const topicTurnsValue = record.topicTurns;
  if (
    topicTurnsValue !== undefined &&
    (typeof topicTurnsValue !== 'number' ||
      !Number.isSafeInteger(topicTurnsValue) ||
      topicTurnsValue < 0)
  ) {
    throw new RequestError(
      'topicTurns must be a non-negative safe integer.',
      400,
    );
  }
  const topicTurns =
    typeof topicTurnsValue === 'number' ? topicTurnsValue : 0;

  const viewerIntentValue = record.viewerIntent;
  if (
    viewerIntentValue !== undefined &&
    viewerIntentValue !== null &&
    !isViewerIntent(viewerIntentValue)
  ) {
    throw new RequestError(
      'viewerIntent must be a known intent or null.',
      400,
    );
  }
  const viewerIntent =
    viewerIntentValue === null || viewerIntentValue === undefined
      ? null
      : viewerIntentValue;

  const viewerTurnsSinceValue = record.viewerTurnsSince;
  if (
    viewerTurnsSinceValue !== undefined &&
    (typeof viewerTurnsSinceValue !== 'number' ||
      !Number.isSafeInteger(viewerTurnsSinceValue) ||
      viewerTurnsSinceValue < 0)
  ) {
    throw new RequestError(
      'viewerTurnsSince must be a non-negative safe integer.',
      400,
    );
  }
  const viewerTurnsSince =
    typeof viewerTurnsSinceValue === 'number' ? viewerTurnsSinceValue : 0;

  const viewerEngagementValue = record.viewerEngagement;
  if (
    viewerEngagementValue !== undefined &&
    !isViewerEngagement(viewerEngagementValue)
  ) {
    throw new RequestError(
      'viewerEngagement must be available or settled.',
      400,
    );
  }
  const viewerEngagement =
    viewerEngagementValue === undefined ? 'available' : viewerEngagementValue;

  const programContextValue = record.programContext;
  if (
    programContextValue !== undefined &&
    !isProgramContext(programContextValue)
  ) {
    throw new RequestError('programContext format is invalid.', 400);
  }
  const programContext =
    programContextValue === undefined
      ? DEFAULT_PROGRAM_CONTEXT
      : programContextValue;

  const performerStateValue = record.performerState;
  const performerState = readPerformerStateContext(performerStateValue);

  const performanceContextValue = record.performanceContext;
  let performanceContext: PerformanceContextPayload = {
    callbackTendency: 0,
    fragmentation: 0,
    semanticBiases: [],
  };
  if (performanceContextValue !== undefined) {
    performanceContext = readPerformanceContext(performanceContextValue);
  }

  const autonomyCandidateValue = record.autonomyCandidate;
  let autonomyCandidate: AutonomyCandidate | null = null;
  if (mode === 'autonomous') {
    if (autonomyCandidateValue === undefined) {
      throw new RequestError(
        'autonomous requests must contain autonomyCandidate.',
        400,
      );
    }
    try {
      autonomyCandidate = readAutonomyCandidate(autonomyCandidateValue);
    } catch (error) {
      if (error instanceof CardContractError) {
        throw new RequestError(error.message, 400);
      }
      throw error;
    }
  } else if (autonomyCandidateValue !== undefined) {
    throw new RequestError(
      'autonomyCandidate is only valid for autonomous requests.',
      400,
    );
  }

  if (
    mode === 'autonomous' &&
    (topicValue === undefined ||
      topicTurnsValue === undefined ||
      viewerIntentValue === undefined ||
      viewerTurnsSinceValue === undefined ||
      viewerEngagementValue === undefined ||
      programContextValue === undefined ||
      performerStateValue === undefined ||
      performerState === null ||
      autonomyCandidate === null)
  ) {
    throw new RequestError(
      'autonomous requests must contain topic, topicTurns, viewerIntent, viewerTurnsSince, viewerEngagement, programContext, performerState, and autonomyCandidate.',
      400,
    );
  }
  if (topicTurns > MAX_TOPIC_TURNS) {
    throw new RequestError(
      `topicTurns must be ${MAX_TOPIC_TURNS} or fewer.`,
      400,
    );
  }
  if (viewerTurnsSince > MAX_VIEWER_TURNS_SINCE) {
    throw new RequestError(
      `viewerTurnsSince must be ${MAX_VIEWER_TURNS_SINCE} or fewer.`,
      400,
    );
  }

  const cardContinuation = record.cardContinuation;
  if (cardContinuation !== undefined && (!isCardContinuation(cardContinuation) || forcedCardId === null)) {
    throw new RequestError('cardContinuation requires valid continuation context and a forced card.', 400);
  }

  return {
    ...(cardContinuation === undefined ? {} : { cardContinuation }),
    mode,
    message: normalizedMessage,
    ...(record.greeting === true ? { greeting: true as const } : {}),
    characterIdentity,
    history: normalizedHistory,
    brainCardIds,
    forcedCardId,
    topic,
    topicTurns,
    viewerIntent,
    viewerTurnsSince,
    viewerEngagement,
    programContext,
    performerState,
    lastSelfUtterance,
    performanceContext,
    autonomyCandidate,
    streamSpeech:
      streamSpeechRequested &&
      (mode !== 'autonomous' ||
        (forcedCardId !== null && programContext.phase === 'after_card_change')),
    earlySpeechLead: record.earlySpeechLead !== false,
    recentExpressionLevels,
  };
}

export function readTtsRequest(payload: unknown): {
  text: string;
  emotion: Emotion;
  unitIndex: number;
  ttsProfile?: {
    rateScale: number;
    intonationScale: number;
  };
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== 'text' &&
        key !== 'emotion' &&
        key !== 'ttsProfile' &&
        key !== 'unitIndex',
    )
  ) {
    throw new RequestError(
      'Request body may contain only text, emotion, ttsProfile, and unitIndex.',
      400,
    );
  }

  const text = record.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new RequestError('text must be non-empty text.', 400);
  }
  const normalizedText = text.trim();
  if (normalizedText.length > MAX_TEXT_LENGTH) {
    throw new RequestError(
      `text must be ${MAX_TEXT_LENGTH} characters or fewer.`,
      400,
    );
  }

  const unitIndex = record.unitIndex ?? 0;
  if (
    typeof unitIndex !== 'number' ||
    !Number.isSafeInteger(unitIndex) ||
    unitIndex < 0 ||
    unitIndex > MAX_SPEECH_UNIT_INDEX
  ) {
    throw new RequestError(`unitIndex must be between 0 and ${MAX_SPEECH_UNIT_INDEX}.`, 400);
  }

  let ttsProfile: {
    rateScale: number;
    intonationScale: number;
  } | undefined;
  if (record.ttsProfile !== undefined) {
    if (
      !record.ttsProfile ||
      typeof record.ttsProfile !== 'object' ||
      Array.isArray(record.ttsProfile)
    ) {
      throw new RequestError('ttsProfile must be an object.', 400);
    }
    const profile = record.ttsProfile as Record<string, unknown>;
    if (
      Object.keys(profile).some(
        (key) => key !== 'rateScale' && key !== 'intonationScale',
      )
    ) {
      throw new RequestError('ttsProfile contains an unsupported field.', 400);
    }
    const rateScale = profile.rateScale;
    const intonationScale = profile.intonationScale;
    if (
      typeof rateScale !== 'number' ||
      !Number.isFinite(rateScale) ||
      rateScale < 0.5 ||
      rateScale > 1.5 ||
      typeof intonationScale !== 'number' ||
      !Number.isFinite(intonationScale) ||
      intonationScale < 0.5 ||
      intonationScale > 1.5
    ) {
      throw new RequestError('ttsProfile format is invalid.', 400);
    }
    ttsProfile = { rateScale, intonationScale };
  }

  return {
    text: normalizedText,
    emotion: normalizeEmotion(record.emotion),
    unitIndex,
    ttsProfile,
  };
}

export function readBoundedText(
  value: unknown,
  field: string,
  maximum = MAX_AUTONOMY_CONTENT_LENGTH,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CardContractError(`${field} must be non-empty text.`);
  }
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (text.length > maximum) {
    throw new CardContractError(
      `${field} must be ${maximum} characters or fewer.`,
    );
  }
  return text;
}

export function readStringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength = 128,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    !value.every(
      (item) => typeof item === 'string' && item.trim().length <= maximumLength,
    )
  ) {
    throw new CardContractError(`${field} format is invalid.`);
  }
  const values = value.map((item) => (item as string).trim());
  if (new Set(values).size !== values.length) {
    throw new CardContractError(`${field} must not contain duplicates.`);
  }
  return values;
}

export function readAutonomyCandidate(value: unknown): AutonomyCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('autonomyCandidate must be an object.', 400);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'episodeId',
    'decisionEvidenceIds',
    'reasons',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError(
      'autonomyCandidate contains an unsupported field.',
      400,
    );
  }
  const episodeId = readBoundedText(record.episodeId, 'episodeId', 128);
  const decisionEvidenceIds = readStringList(
    record.decisionEvidenceIds,
    'decisionEvidenceIds',
    MAX_DECISION_EVIDENCE_IDS,
  );
  if (!decisionEvidenceIds.length) {
    throw new RequestError(
      'autonomyCandidate.decisionEvidenceIds must contain at least one evidence ID.',
      400,
    );
  }
  const reasonValues = record.reasons;
  if (
    !Array.isArray(reasonValues) ||
    reasonValues.length < 1 ||
    reasonValues.length > MAX_CANDIDATE_REASONS
  ) {
    throw new RequestError('autonomyCandidate.reasons format is invalid.', 400);
  }

  const candidateReasonIds = new Set<string>();
  const reasons: CandidateReason[] = reasonValues.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RequestError('autonomyCandidate reason must be an object.', 400);
    }
    const reason = value as Record<string, unknown>;
    const allowedReasonKeys = new Set([
      'id',
      'episodeId',
      'parentReasonId',
      'kind',
      'content',
      'semanticKey',
      'salience',
      'status',
      'deferCause',
      'wakeOn',
      'decisionEvidenceIds',
    ]);
    if (Object.keys(reason).some((key) => !allowedReasonKeys.has(key))) {
      throw new RequestError(
        'autonomyCandidate reason contains an unsupported field.',
        400,
      );
    }
    const id = readBoundedText(reason.id, 'reason.id', 128);
    if (candidateReasonIds.has(id)) {
      throw new RequestError('autonomyCandidate reason IDs must be unique.', 400);
    }
    candidateReasonIds.add(id);
    const reasonEpisodeId = readBoundedText(
      reason.episodeId,
      'reason.episodeId',
      128,
    );
    if (reasonEpisodeId !== episodeId) {
      throw new RequestError(
        'autonomyCandidate reasons must use the candidate episode ID.',
        400,
      );
    }
    const parentReasonId =
      reason.parentReasonId === null || reason.parentReasonId === undefined
        ? null
        : readBoundedText(reason.parentReasonId, 'reason.parentReasonId', 128);
    if (!isCandidateReasonKind(reason.kind)) {
      throw new RequestError('autonomyCandidate reason kind is invalid.', 400);
    }
    const content = readBoundedText(reason.content, 'reason.content');
    const semanticKey = readBoundedText(reason.semanticKey, 'reason.semanticKey');
    const salience = reason.salience;
    if (
      typeof salience !== 'number' ||
      !Number.isFinite(salience) ||
      salience < 0 ||
      salience > 1
    ) {
      throw new RequestError('autonomyCandidate reason salience is invalid.', 400);
    }
    if (reason.status !== 'active') {
      throw new RequestError(
        'autonomyCandidate can contain only active reasons.',
        400,
      );
    }
    if (reason.deferCause !== null && reason.deferCause !== undefined) {
      throw new RequestError(
        'active autonomyCandidate reasons cannot have deferCause.',
        400,
      );
    }
    const wakeOn = readStringList(reason.wakeOn, 'reason.wakeOn', 6);
    if (!wakeOn.every(isAutonomyWakeCondition)) {
      throw new RequestError('autonomyCandidate reason wakeOn is invalid.', 400);
    }
    const reasonEvidenceIds = readStringList(
      reason.decisionEvidenceIds,
      'reason.decisionEvidenceIds',
      MAX_DECISION_EVIDENCE_IDS,
    );
    if (!reasonEvidenceIds.length) {
      throw new RequestError(
        'autonomyCandidate reason decisionEvidenceIds must not be empty.',
        400,
      );
    }
    if (!reasonEvidenceIds.every((id) => decisionEvidenceIds.includes(id))) {
      throw new RequestError(
        'autonomyCandidate reason decisionEvidenceIds must be offered evidence.',
        400,
      );
    }
    return {
      id,
      episodeId,
      parentReasonId,
      kind: reason.kind,
      content,
      semanticKey,
      salience,
      status: 'active',
      deferCause: null,
      wakeOn,
      decisionEvidenceIds: reasonEvidenceIds,
      createdAt: 0,
      updatedAt: 0,
      lastEvaluatedEvidenceId: null,
      mergedIntoReasonId: null,
    };
  });

  for (const reason of reasons) {
    if (
      reason.parentReasonId !== null &&
      (reason.parentReasonId === reason.id ||
        !candidateReasonIds.has(reason.parentReasonId))
    ) {
      throw new RequestError(
        'autonomyCandidate reason parent must be another offered reason.',
        400,
      );
    }
  }

  return { episodeId, reasons, decisionEvidenceIds };
}

export function readReasonUpdates(
  value: unknown,
  candidate: AutonomyCandidate | null,
): AutonomyInternalDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CardContractError('internalDelta must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'reasonUpdates')) {
    throw new CardContractError('internalDelta contains an unsupported field.');
  }
  const updateValues = record.reasonUpdates;
  if (
    !Array.isArray(updateValues) ||
    updateValues.length > MAX_REASON_UPDATES_PER_DELTA
  ) {
    throw new CardContractError('internalDelta.reasonUpdates format is invalid.');
  }
  const offeredReasons = new Map(
    (candidate?.reasons ?? []).map((reason) => [reason.id, reason]),
  );
  const touchedIds = new Set<string>();
  const createdSemanticKeys = new Set<string>();
  const updates: ReasonUpdate[] = [];
  const assertKnownReasonUpdateFields = (
    update: Record<string, unknown>,
    message: string,
  ) => {
    if (Object.keys(update).some((key) => !AUTONOMY_REASON_UPDATE_FIELDS.has(key))) {
      throw new CardContractError(message);
    }
  };
  for (const value of updateValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CardContractError('reason update must be an object.');
    }
    const update = value as Record<string, unknown>;
    const operation = update.operation;
    if (typeof operation !== 'string') {
      throw new CardContractError('reason update operation is invalid.');
    }
    const requireReason = () => {
      const reasonId = readBoundedText(update.reasonId, 'reasonId', 128);
      const reason = offeredReasons.get(reasonId);
      if (!reason) {
        throw new CardContractError('reason update references an unknown reason.');
      }
      if (touchedIds.has(reasonId)) {
        throw new CardContractError('reason updates must not duplicate a reason.');
      }
      touchedIds.add(reasonId);
      return { reasonId, reason };
    };
    if (operation === 'create') {
      assertKnownReasonUpdateFields(
        update,
        'create reason update contains an unsupported field.',
      );
      if (!isCandidateReasonKind(update.kind)) {
        throw new CardContractError('create reason update kind is invalid.');
      }
      const content = readBoundedText(update.content, 'reason content');
      const semanticKey = readBoundedText(update.semanticKey, 'reason semanticKey');
      if (createdSemanticKeys.has(semanticKey)) {
        throw new CardContractError('reason updates must not duplicate a semantic key.');
      }
      createdSemanticKeys.add(semanticKey);
      const salience = update.salience;
      if (
        typeof salience !== 'number' ||
        !Number.isFinite(salience) ||
        salience < 0 ||
        salience > 1
      ) {
        throw new CardContractError('create reason salience is invalid.');
      }
      const parentReasonId =
        update.parentReasonId === null || update.parentReasonId === undefined
          ? null
          : readBoundedText(update.parentReasonId, 'parentReasonId', 128);
      if (parentReasonId && !offeredReasons.has(parentReasonId)) {
        throw new CardContractError('create reason parent is unknown.');
      }
      updates.push({
        operation: 'create',
        kind: update.kind,
        content,
        semanticKey,
        salience,
        parentReasonId,
      });
      continue;
    }
    if (operation === 'reinforce') {
      assertKnownReasonUpdateFields(
        update,
        'reinforce reason update contains an unsupported field.',
      );
      const { reasonId, reason } = requireReason();
      const content =
        update.content === undefined || update.content === null
          ? undefined
          : readBoundedText(update.content, 'reason content');
      const salienceDelta =
        update.salienceDelta === undefined || update.salienceDelta === null
          ? undefined
          : update.salienceDelta;
      if (
        salienceDelta !== undefined &&
        (typeof salienceDelta !== 'number' ||
          !Number.isFinite(salienceDelta) ||
          salienceDelta < -1 ||
          salienceDelta > 1)
      ) {
        throw new CardContractError('reason salienceDelta is invalid.');
      }
      if (reason.status !== 'active') {
        throw new CardContractError('reinforce requires an active reason.');
      }
      updates.push({ operation: 'reinforce', reasonId, ...(content === undefined ? {} : { content }), ...(salienceDelta === undefined ? {} : { salienceDelta }) });
      continue;
    }
    if (operation === 'resolve' || operation === 'expire') {
      assertKnownReasonUpdateFields(
        update,
        'reason status update contains an unsupported field.',
      );
      const { reasonId, reason } = requireReason();
      if (reason.status !== 'active') {
        throw new CardContractError('reason status transition is invalid.');
      }
      updates.push({ operation, reasonId });
      continue;
    }
    if (operation === 'defer') {
      assertKnownReasonUpdateFields(
        update,
        'defer reason update contains an unsupported field.',
      );
      const { reasonId, reason } = requireReason();
      if (reason.status !== 'active' || !isAutonomyDeferCause(update.cause)) {
        throw new CardContractError('defer reason update is invalid.');
      }
      const wakeOn = readStringList(update.wakeOn, 'wakeOn', 6);
      if (!wakeOn.length || !wakeOn.every(isAutonomyWakeCondition)) {
        throw new CardContractError('defer reason wakeOn is invalid.');
      }
      updates.push({ operation, reasonId, cause: update.cause, wakeOn });
      continue;
    }
    if (operation === 'reactivate') {
      assertKnownReasonUpdateFields(
        update,
        'reactivate reason update contains an unsupported field.',
      );
      const { reasonId, reason } = requireReason();
      if (reason.status !== 'deferred' && reason.status !== 'expired') {
        throw new CardContractError('reactivate reason status is invalid.');
      }
      const salienceDelta =
        update.salienceDelta === undefined || update.salienceDelta === null
          ? undefined
          : update.salienceDelta;
      if (
        salienceDelta !== undefined &&
        (typeof salienceDelta !== 'number' || !Number.isFinite(salienceDelta) || salienceDelta < -1 || salienceDelta > 1)
      ) {
        throw new CardContractError('reactivate salienceDelta is invalid.');
      }
      updates.push({ operation, reasonId, ...(salienceDelta === undefined ? {} : { salienceDelta }) });
      continue;
    }
    if (operation === 'merge') {
      assertKnownReasonUpdateFields(
        update,
        'merge reason update contains an unsupported field.',
      );
      const { reasonId } = requireReason();
      const targetReasonId = readBoundedText(update.targetReasonId, 'targetReasonId', 128);
      const target = offeredReasons.get(targetReasonId);
      if (!target || targetReasonId === reasonId || target.status !== 'active') {
        throw new CardContractError('merge reason target is invalid.');
      }
      if (touchedIds.has(targetReasonId)) {
        throw new CardContractError('reason updates must not duplicate a reason.');
      }
      touchedIds.add(targetReasonId);
      updates.push({ operation, reasonId, targetReasonId });
      continue;
    }
    throw new CardContractError('reason update operation is invalid.');
  }
  return { reasonUpdates: updates };
}

export function readUsedReasonIds(
  value: unknown,
  candidate: AutonomyCandidate,
): string[] {
  const usedReasonIds = readStringList(value, 'usedReasonIds', candidate.reasons.length);
  const offeredIds = new Set(candidate.reasons.map((reason) => reason.id));
  if (usedReasonIds.some((reasonId) => !offeredIds.has(reasonId))) {
    throw new CardContractError(
      'usedReasonIds must reference the offered candidate reasons.',
    );
  }
  return usedReasonIds;
}

export function parseAssistantResponse(
  value: string,
  mode: ChatMode,
  brainCardIds: readonly string[],
  forcedCardId: string | null,
  message: string | null,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
  autonomyCandidate: AutonomyCandidate | null = null,
  expressionBudget: ExpressionLevel = 'high',
): CardAssistantResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new CardContractError('The chat provider returned invalid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CardContractError(
      'The chat provider returned an invalid response object.',
    );
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.text !== 'string') {
    throw new CardContractError(
      'The chat provider returned invalid response text.',
    );
  }

  const text = record.text.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new CardContractError(
      'The chat provider returned response text that is too long.',
    );
  }

  const hasInternalDelta = record.internalDelta !== undefined;
  if (mode === 'autonomous' && !hasInternalDelta) {
    throw new CardContractError('Autonomous responses require internalDelta.');
  }
  const internalDelta = readReasonUpdates(
    hasInternalDelta ? record.internalDelta : { reasonUpdates: [] },
    mode === 'autonomous' ? autonomyCandidate : null,
  );
  let externalAction: AutonomyExternalAction | undefined;
  let usedReasonIds: string[] | undefined;
  let voiceAction: VoiceInteractionAction | undefined;
  let backchannelCue: VoiceBackchannelCue | undefined;
  if (mode === 'voice') {
    if (!isVoiceInteractionAction(record.voiceAction)) {
      throw new VoicePolicyContractError(
        'Voice response action must be listen, backchannel, react_nonverbally, or take_floor.',
      );
    }
    if (!isVoiceBackchannelCue(record.backchannelCue)) {
      throw new VoicePolicyContractError(
        'Voice response backchannel cue is invalid.',
      );
    }
    voiceAction = record.voiceAction;
    backchannelCue = record.backchannelCue;
    if (!isVoiceInteractionDecision({ action: voiceAction, backchannelCue })) {
      throw new VoicePolicyContractError(
        'Voice response action and backchannel cue are incompatible.',
      );
    }
    if (voiceAction === 'take_floor' && !text) {
      throw new VoicePolicyContractError(
        'Voice take_floor responses must contain text.',
      );
    }
    if (voiceAction !== 'take_floor' && text) {
      throw new VoicePolicyContractError(
        'Voice listen, react_nonverbally, and backchannel responses must contain empty text.',
      );
    }
    const normalizedDecision = normalizeVoiceAssistantResponseDecision(
      message ?? '',
      {
        action: voiceAction,
        backchannelCue,
      },
      characterIdentity,
    );
    if (normalizedDecision.action !== voiceAction) {
      throw new VoicePolicyContractError(
        'Content-bearing voice responses must use take_floor.',
      );
    }
    if (
      voiceAction === 'take_floor' &&
      isContentBearingVoiceMessage(message ?? '') &&
      isDefiniteBackchannelMessage(text) &&
      !isDefiniteQuestionMessage(message ?? '')
    ) {
      throw new VoicePolicyContractError(
        'Content-bearing voice take_floor responses must contain a concrete reaction, not only a backchannel.',
      );
    }
    if (
      voiceAction === 'take_floor' &&
      (isActionCommitmentMessage(message ?? '') ||
        isDirectActionRequestMessage(message ?? '')) &&
      isMetaOnlyActionResponse(text)
    ) {
      throw new VoicePolicyContractError(
        'Action commitments must lead to concrete content or a concrete missing-information question, not only meta agreement.',
      );
    }
  } else if (mode === 'autonomous') {
    if (!autonomyCandidate) {
      throw new CardContractError(
        'Autonomous responses require an offered autonomy candidate.',
      );
    }
    if (!isAutonomyExternalAction(record.externalAction)) {
      throw new CardContractError(
        'Autonomous response externalAction must be speak or none.',
      );
    }
    externalAction = record.externalAction;
    usedReasonIds = readUsedReasonIds(record.usedReasonIds, autonomyCandidate);
    if (externalAction === 'speak' && !text) {
      throw new CardContractError(
        'Autonomous speaking responses must contain text.',
      );
    }
    if (externalAction === 'none' && text) {
      throw new CardContractError(
        'Autonomous none responses must contain empty text.',
      );
    }
    if (externalAction === 'speak' && !usedReasonIds.length) {
      throw new CardContractError(
        'Autonomous speaking responses must use at least one reason.',
      );
    }
  } else if (!text) {
    throw new CardContractError('The chat provider returned empty response text.');
  }

  const isSpeaking =
    mode === 'manual' ||
    (mode === 'voice' && voiceAction === 'take_floor') ||
    (mode === 'autonomous' && externalAction === 'speak');
  const speechAct = record.speechAct;
  const expressionLevel = record.expressionLevel;
  if (isSpeaking) {
    if (!isSpeechAct(speechAct)) {
      throw new CardContractError(
        'Speaking responses must contain a valid speechAct.',
      );
    }
    if (!isExpressionLevel(expressionLevel)) {
      throw new CardContractError(
        'Speaking responses must contain a valid expressionLevel.',
      );
    }
    if (!isWithinExpressionBudget(expressionLevel, expressionBudget)) {
      throw new CardContractError(
        'expressionLevel must not exceed the runtime expression budget.',
      );
    }
  } else if (speechAct !== null || expressionLevel !== null) {
    throw new CardContractError(
      'Non-speaking responses must use null speechAct and expressionLevel.',
    );
  }

  const activatedCards = record.activatedCards;
  const requiresActivatedCard =
    isSpeaking;
  if (
    !Array.isArray(activatedCards) ||
    (requiresActivatedCard && activatedCards.length < 1) ||
    activatedCards.length > MAX_ACTIVATED_CARDS ||
    !activatedCards.every((id): id is string => typeof id === 'string')
  ) {
    throw new CardContractError(
      `activatedCards must contain ${requiresActivatedCard ? 1 : 0} to ${MAX_ACTIVATED_CARDS} card IDs.`,
    );
  }
  if (new Set(activatedCards).size !== activatedCards.length) {
    throw new CardContractError('activatedCards must not contain duplicates.');
  }
  if (mode === 'voice' && voiceAction !== 'take_floor' && activatedCards.length) {
    throw new VoicePolicyContractError(
      'Voice listen, react_nonverbally, and backchannel responses must not activate cards.',
    );
  }
  if (mode === 'autonomous' && externalAction === 'none' && activatedCards.length) {
    throw new CardContractError(
      'Autonomous none responses must not activate cards.',
    );
  }
  if (activatedCards.some((id) => !brainCardIds.includes(id))) {
    throw new CardContractError(
      'activatedCards must be a subset of the current brain cards.',
    );
  }
  const mustIncludeForcedCard =
    forcedCardId !== null &&
    (mode !== 'voice' || voiceAction === 'take_floor') &&
    !(mode === 'autonomous' && externalAction === 'none');
  if (mustIncludeForcedCard && activatedCards[0] !== forcedCardId) {
    throw new CardContractError(
      'activatedCards must place the forced card first.',
    );
  }

  const response: CardAssistantResponse = {
    text,
    emotion: normalizeEmotion(record.emotion),
    activatedCards,
    speechAct: isSpeaking ? (speechAct as SpeechAct) : null,
    expressionLevel: isSpeaking
      ? (expressionLevel as ExpressionLevel)
      : null,
    ...(hasInternalDelta ? { internalDelta } : {}),
  };
  if (mode === 'autonomous') {
    response.externalAction = externalAction;
    response.usedReasonIds = usedReasonIds;
    if (externalAction === 'none') {
      response.emotion = normalizeEmotion('neutral');
    }
  }
  if (mode === 'voice') {
    response.voiceAction = voiceAction;
    response.backchannelCue = backchannelCue;
    if (voiceAction !== 'take_floor') response.emotion = normalizeEmotion('neutral');
  }
  return response;
}

export function parseVoiceAssistantResponse(
  value: string,
  brainCardIds: readonly string[],
  forcedCardId: string | null,
  message: string,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
  expressionBudget: ExpressionLevel = 'high',
): CardAssistantResponse {
  return parseAssistantResponse(
    value,
    'voice',
    brainCardIds,
    forcedCardId,
    message,
    characterIdentity,
    null,
    expressionBudget,
  );
}

export function parseAutonomousAssistantResponse(
  value: string,
  candidate: AutonomyCandidate,
  brainCardIds: readonly string[],
  forcedCardId: string | null,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
  expressionBudget: ExpressionLevel = 'high',
): CardAssistantResponse {
  return parseAssistantResponse(
    value,
    'autonomous',
    brainCardIds,
    forcedCardId,
    null,
    characterIdentity,
    candidate,
    expressionBudget,
  );
}

export function parseVoiceInteractionPolicy(
  value: string,
): VoiceInteractionDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new ConversationPolicyContractError(
      'The voice interaction policy returned invalid JSON.',
    );
  }

  if (!isVoiceInteractionDecision(payload)) {
    throw new ConversationPolicyContractError(
      'The voice interaction policy returned an invalid action or cue.',
    );
  }

  return payload;
}

export function parseConversationActionPolicy(
  value: string,
): ConversationActionDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new ConversationPolicyContractError(
      'The conversation action policy returned invalid JSON.',
    );
  }

  if (
    !isConversationActionDecision(payload) ||
    payload.action === 'wait' ||
    !(INTERACTIVE_POLICY_ACTIONS as readonly string[]).includes(payload.action)
  ) {
    throw new ConversationPolicyContractError(
      'The conversation action policy returned an invalid action or cue.',
    );
  }

  return payload;
}

export function parseCardPreviewResponse(value: string): AssistantResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error('The card preview provider returned invalid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      'The card preview provider returned an invalid response object.',
    );
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error('The card preview provider returned invalid response text.');
  }

  const text = record.text.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(
      'The card preview provider returned response text that is too long.',
    );
  }

  return {
    text,
    emotion: normalizeEmotion(record.emotion),
  };
}
