import type { Emotion } from '../character/emotion.js';
import type { ConversationAction } from '../performer/types.js';
import type { ConversationSource } from './conversationRuntime.js';
import type { AutonomyTurnGateTelemetry } from './autonomyTurnGate.js';
export const CONVERSATION_EVENTS = [
  'input_received',
  'llm_start',
  'llm_provider_start',
  'llm_provider_first_chunk',
  'llm_provider_done',
  'llm_done',
  'speech_unit_ready',
  'internal_delta_rejected',
  'tts_start',
  'tts_unit_start',
  'tts_unit_audio_ready',
  'tts_unit_playback_started',
  'tts_unit_playback_completed',
  'tts_queue_gap',
  'tts_first_audio',
  'tts_ready',
  'playback_startup',
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

export interface ConversationEventDetails {
  audioContextState?: 'closed' | 'running' | 'suspended';
  audioSourceKind?: 'buffer' | 'stream';
  bufferedDurationMs?: number;
  durationMs?: number;
  emotion?: Emotion;
  firstChunkBytes?: number;
  firstChunkIntervalMs?: number;
  interactionAction?: ConversationAction;
  phase?: 'llm' | 'tts';
  playbackRoute?: 'conversation';
  primingOutcome?: 'cancelled' | 'complete' | 'disabled' | 'target' | 'timeout';
  primingTargetMs?: number;
  primingWaitMs?: number;
  reason?: string;
  sampleRateHz?: number;
  purpose?: 'conversation-policy' | 'response-generation' | 'card-preview';
  callIndex?: number;
  retry?: number;
  unitIndex?: number;
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
