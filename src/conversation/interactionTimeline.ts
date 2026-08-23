import type { ConversationAction } from '../performer/types.js';
import type { BargeInState } from '../voice/audioLab.js';

export type InteractionTimelineSignal =
  | 'speech_started'
  | 'speech_ended'
  | 'utterance_finalized'
  | 'recognition_failed'
  | 'recognition_stopped';

export type InteractionTimelineEvent =
  | {
      kind: 'turn_signal';
      signal: InteractionTimelineSignal;
      at: number;
      segmentId?: string;
      asrConfidence?: number | null;
      reason?: string;
    }
  | {
      kind: 'floor_action';
      action: ConversationAction;
      at: number;
      segmentId: string | null;
      pendingFragmentCount: number;
      asrConfidence?: number | null;
      reason?: string;
    }
  | {
      kind: 'floor_acquired';
      owner: 'user' | 'vayria';
      at: number;
      segmentId: string | null;
    }
  | {
      kind: 'floor_released';
      owner: 'user' | 'vayria' | 'none';
      at: number;
      reason: string;
    }
  | {
      kind: 'pending_expired';
      at: number;
      fragmentCount: number;
    }
  | {
      kind: 'pending_discarded';
      at: number;
      fragmentCount: number;
      reason: string;
    }
  | {
      kind: 'transcript_discarded';
      at: number;
      segmentId: string | null;
      reason: string;
    }
  | {
      kind: 'backchannel_played';
      at: number;
      cue: 'un' | 'uun' | null;
      channel: 'local_preloaded';
    }
  | {
      kind: 'tts_event';
      at: number;
      phase: 'start' | 'ready';
      channel: 'server_tts';
      durationMs?: number;
    }
  | {
      kind: 'barge_in';
      at: number;
      action: string;
      state: BargeInState;
      reason?: string;
    };

export interface InteractionTimeline {
  record(event: InteractionTimelineEvent): void;
  snapshot(): readonly InteractionTimelineEvent[];
  clear(): void;
  setListener(
    listener: ((event: InteractionTimelineEvent) => void) | undefined,
  ): void;
}

const DEFAULT_TIMELINE_LIMIT = 512;

export function createInteractionTimeline(
  onEvent?: (event: InteractionTimelineEvent) => void,
  limit = DEFAULT_TIMELINE_LIMIT,
): InteractionTimeline {
  const events: InteractionTimelineEvent[] = [];
  const normalizedLimit = Math.max(1, Math.floor(limit));
  let listener = onEvent;

  return {
    record(event) {
      events.push({ ...event });
      if (events.length > normalizedLimit) {
        events.splice(0, events.length - normalizedLimit);
      }
      listener?.(event);
    },
    snapshot() {
      return events.map((event) => ({ ...event }));
    },
    clear() {
      events.length = 0;
    },
    setListener(nextListener) {
      listener = nextListener;
    },
  };
}
