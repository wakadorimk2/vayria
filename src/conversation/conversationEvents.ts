import type { Emotion } from '../character/emotion';
import { runtimeConfig } from '../runtimeConfig';
import type { ConversationSource } from './useConversation';
import {
  isVoiceInteractionAction,
  type VoiceInteractionAction,
} from '../voice/voiceInteraction';

export const CONVERSATION_EVENTS = [
  'input_received',
  'llm_start',
  'llm_done',
  'tts_start',
  'tts_ready',
  'motion_ready',
  'motion_start',
  'animation_start',
  'turn_completed',
  'turn_aborted',
  'turn_failed',
] as const;

export type ConversationEventName = (typeof CONVERSATION_EVENTS)[number];

interface ConversationEventDetails {
  durationMs?: number;
  emotion?: Emotion;
  interactionAction?: VoiceInteractionAction;
  phase?: 'llm' | 'tts';
  reason?: string;
}

export interface ConversationEvent extends ConversationEventDetails {
  at: string;
  elapsedMs: number;
  event: ConversationEventName;
  runId?: string;
  source: ConversationSource;
  turnId: string;
}

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
    isVoiceInteractionAction(details.interactionAction)
      ? { interactionAction: details.interactionAction }
      : {}),
    ...(details.phase ? { phase: details.phase } : {}),
    ...(details.reason ? { reason: details.reason.slice(0, 120) } : {}),
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
