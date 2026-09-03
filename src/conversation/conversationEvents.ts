import type { Emotion } from '../character/emotion';
import { runtimeConfig } from '../runtimeConfig';
import type { ConversationSource } from './useConversation';
import {
  AUTONOMY_TURN_GATE_BLOCK_REASONS,
  AUTONOMY_TURN_GATE_EVENTS,
  AUTONOMY_TURN_GATE_EXTERNAL_EVENTS,
  AUTONOMY_TURN_GATE_PHASES,
  AUTONOMY_TURN_GATE_TRANSITIONS,
  type AutonomyTurnGateTelemetry,
} from './autonomyTurnGate.js';
import {
  isConversationAction,
  type ConversationAction,
} from '../performer/types';

export const CONVERSATION_EVENTS = [
  'input_received',
  'llm_start',
  'llm_done',
  'speech_unit_ready',
  'internal_delta_rejected',
  'tts_start',
  'tts_first_audio',
  'tts_ready',
  'playback_started',
  'playback_gesture_required',
  'tts_completed',
  'motion_ready',
  'motion_start',
  'animation_start',
  'turn_completed',
  'turn_aborted',
  'turn_failed',
  'autonomy_gate',
] as const;

export type ConversationEventName = (typeof CONVERSATION_EVENTS)[number];

interface ConversationEventDetails {
  durationMs?: number;
  emotion?: Emotion;
  interactionAction?: ConversationAction;
  phase?: 'llm' | 'tts';
  reason?: string;
}

export type ConversationEvent = ConversationEventDetails &
  Partial<AutonomyTurnGateTelemetry> & {
  at: string;
  elapsedMs: number;
  event: ConversationEventName;
  runId?: string;
  source: ConversationSource;
  turnId: string;
  };

function createTurnId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readSafeDetails(
  details: ConversationEventDetails,
): ConversationEventDetails {
  return {
    ...(typeof details.durationMs === 'number' &&
    Number.isFinite(details.durationMs)
      ? { durationMs: Math.max(0, Math.round(details.durationMs)) }
      : {}),
    ...(details.emotion ? { emotion: details.emotion } : {}),
    ...(details.interactionAction &&
    isConversationAction(details.interactionAction)
      ? { interactionAction: details.interactionAction }
      : {}),
    ...(details.phase ? { phase: details.phase } : {}),
    ...(details.reason ? { reason: details.reason.slice(0, 120) } : {}),
  };
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;

function readSafeId(value: string | undefined): string | undefined {
  return value && SAFE_ID_PATTERN.test(value) ? value : undefined;
}

function readSafeIdList(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const safeValues = values
    .filter((value): value is string => SAFE_ID_PATTERN.test(value))
    .slice(0, 16);
  return safeValues.length ? safeValues : undefined;
}

function readSafeGateDetails(
  details: AutonomyTurnGateTelemetry,
): Partial<AutonomyTurnGateTelemetry> {
  const candidateEpisodeId = readSafeId(details.candidateEpisodeId);
  const candidateReasonIds = readSafeIdList(details.candidateReasonIds);
  const candidateEvidenceIds = readSafeIdList(details.candidateEvidenceIds);
  const usedReasonIds = readSafeIdList(details.usedReasonIds);
  const internalDeltaOperations = readSafeIdList(
    details.internalDeltaOperations,
  );
  const affectedReasonIds = readSafeIdList(details.affectedReasonIds);
  const createdReasonIds = readSafeIdList(details.createdReasonIds);
  const resolvedReasonIds = readSafeIdList(details.resolvedReasonIds);

  return {
    ...(AUTONOMY_TURN_GATE_EVENTS.includes(details.gateEvent)
      ? { gateEvent: details.gateEvent }
      : {}),
    ...(AUTONOMY_TURN_GATE_PHASES.includes(details.gatePhase)
      ? { gatePhase: details.gatePhase }
      : {}),
    ...(details.transition &&
    AUTONOMY_TURN_GATE_TRANSITIONS.includes(details.transition)
      ? { transition: details.transition }
      : {}),
    ...(details.blockedBy &&
    AUTONOMY_TURN_GATE_BLOCK_REASONS.includes(details.blockedBy)
      ? { blockedBy: details.blockedBy }
      : {}),
    ...(details.externalEvent &&
    AUTONOMY_TURN_GATE_EXTERNAL_EVENTS.includes(details.externalEvent)
      ? { externalEvent: details.externalEvent }
      : {}),
    ...(candidateEpisodeId ? { candidateEpisodeId } : {}),
    ...(candidateReasonIds ? { candidateReasonIds } : {}),
    ...(candidateEvidenceIds ? { candidateEvidenceIds } : {}),
    ...(usedReasonIds ? { usedReasonIds } : {}),
    ...(internalDeltaOperations ? { internalDeltaOperations } : {}),
    ...(affectedReasonIds ? { affectedReasonIds } : {}),
    ...(createdReasonIds ? { createdReasonIds } : {}),
    ...(resolvedReasonIds ? { resolvedReasonIds } : {}),
    ...(details.externalAction === 'speak' || details.externalAction === 'none'
      ? { externalAction: details.externalAction }
      : {}),
    ...(typeof details.nextEligibleAt === 'number' &&
    Number.isSafeInteger(details.nextEligibleAt) &&
    details.nextEligibleAt >= 0
      ? { nextEligibleAt: details.nextEligibleAt }
      : details.nextEligibleAt === null
        ? { nextEligibleAt: null }
        : {}),
    ...(typeof details.delayMs === 'number' &&
    Number.isSafeInteger(details.delayMs) &&
    details.delayMs >= 0
      ? { delayMs: details.delayMs }
      : {}),
  };
}

function sendEventToLocalApi(event: ConversationEvent): void {
  void fetch('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Performer-Turn-Id': event.turnId,
      ...(event.runId ? { 'X-Performer-Run-Id': event.runId } : {}),
    },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => {
    // Telemetry must not change the conversation result.
  });
}

const AUTONOMY_GATE_TURN_ID = `autonomy-gate-${Date.now()}`;
const autonomyGateStartedAt = performance.now();

export function emitAutonomyGateEvent(
  details: AutonomyTurnGateTelemetry,
): void {
  if (!import.meta.env.DEV) return;

  const payload: ConversationEvent = {
    at: new Date().toISOString(),
    elapsedMs: Math.max(
      0,
      Math.round(performance.now() - autonomyGateStartedAt),
    ),
    event: 'autonomy_gate',
    ...(runtimeConfig.playcheckRunId
      ? { runId: runtimeConfig.playcheckRunId }
      : {}),
    source: 'autonomous',
    turnId: AUTONOMY_GATE_TURN_ID,
    ...readSafeGateDetails(details),
  };

  console.info('[performer-event]', payload);
  sendEventToLocalApi(payload);
}

export function createConversationEventEmitter(
  source: ConversationSource,
) {
  const turnId = createTurnId();
  const startedAt = performance.now();
  const runId = runtimeConfig.playcheckRunId;

  return {
    emit(event: ConversationEventName, details: ConversationEventDetails = {}) {
      const payload: ConversationEvent = {
        at: new Date().toISOString(),
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        event,
        ...(runId ? { runId } : {}),
        source,
        turnId,
        ...readSafeDetails(details),
      };

      if (!import.meta.env.DEV) return;

      try {
        performance.mark(
          `performer:${event}:${turnId}:${payload.elapsedMs}`,
        );
      } catch {
        // Performance marks are optional diagnostics.
      }
      console.info('[performer-event]', payload);
      sendEventToLocalApi(payload);
    },
    runId,
    turnId,
  };
}
