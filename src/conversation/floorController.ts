import type {
  ConversationAction,
  ConversationActionDecision,
} from '../performer/types.js';
import { isContentBearingVoiceMessage } from '../performer/runtime.js';
import type { VoiceInputEvent } from '../voice/voiceInput.js';
import type {
  InteractionTimeline,
  InteractionTimelineEvent,
  InteractionTimelineSignal,
} from './interactionTimeline.js';

export const PENDING_USER_FLOOR_TTL_MS = 10_000;
export const MAX_PENDING_USER_FRAGMENTS = 4;
export const MAX_PENDING_USER_TEXT_LENGTH = 1_000;

export type FloorOwner = 'none' | 'user' | 'vayria';

export interface PendingUserFragment {
  segmentId: string;
  text: string;
  capturedAt: number;
  expiresAt: number;
  asrConfidence: number | null;
}

export interface FloorControllerState {
  floorOwner: FloorOwner;
  activeSegmentId: string | null;
  pendingUserFloor: readonly PendingUserFragment[];
  generation: number;
}

export interface FloorPreview {
  candidateText: string;
  pendingFragmentCount: number;
  generation: number;
}

export interface VoiceTurnMetadata {
  segmentId: string;
  at: number;
  asrConfidence?: number | null;
}

export interface FloorTransition {
  state: FloorControllerState;
  action: ConversationAction | null;
  candidateText: string | null;
  committedText: string | null;
}

export type TurnSignal =
  | { type: 'speech_started'; segmentId: string; at: number }
  | { type: 'speech_ended'; segmentId: string; at: number }
  | {
      type: 'utterance_finalized';
      segmentId: string;
      text: string;
      at: number;
      asrConfidence?: number | null;
    }
  | { type: 'recognition_failed'; code: string; at: number }
  | { type: 'recognition_stopped'; at: number };

function normalizeText(text: string): string {
  return text.normalize('NFKC').trim();
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value);
}

function normalizeConfidence(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createInitialState(): FloorControllerState {
  return {
    floorOwner: 'none',
    activeSegmentId: null,
    pendingUserFloor: [],
    generation: 0,
  };
}

function hasExpired(fragment: PendingUserFragment, now: number): boolean {
  return fragment.expiresAt <= now;
}

function appendPendingFragment(
  fragments: readonly PendingUserFragment[],
  fragment: PendingUserFragment,
): readonly PendingUserFragment[] {
  const bounded = [...fragments, fragment].slice(-MAX_PENDING_USER_FRAGMENTS);
  let remaining = MAX_PENDING_USER_TEXT_LENGTH;
  const retained: PendingUserFragment[] = [];

  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const current = bounded[index];
    if (!current || remaining <= 0) continue;
    const text = current.text.slice(0, remaining);
    retained.unshift({ ...current, text });
    remaining -= text.length;
  }

  return retained;
}

function createTimelineEventForSignal(
  signal: TurnSignal,
): InteractionTimelineEvent {
  const signalType: InteractionTimelineSignal = signal.type;
  switch (signal.type) {
    case 'speech_started':
    case 'speech_ended':
      return {
        kind: 'turn_signal',
        signal: signalType,
        at: signal.at,
        segmentId: signal.segmentId,
      };
    case 'utterance_finalized':
      return {
        kind: 'turn_signal',
        signal: signalType,
        at: signal.at,
        segmentId: signal.segmentId,
        asrConfidence: normalizeConfidence(signal.asrConfidence),
      };
    case 'recognition_failed':
      return {
        kind: 'turn_signal',
        signal: signalType,
        at: signal.at,
        reason: signal.code.slice(0, 120),
      };
    case 'recognition_stopped':
      return {
        kind: 'turn_signal',
        signal: signalType,
        at: signal.at,
      };
  }
}

export function toTurnSignal(event: VoiceInputEvent): TurnSignal {
  switch (event.type) {
    case 'speech_started':
    case 'speech_ended':
      return event;
    case 'utterance_finalized':
      return event;
    case 'recognition_failed':
      return event;
    case 'recognition_stopped':
      return event;
    case 'listening_started':
      return { type: 'recognition_stopped', at: event.at };
    case 'interim_transcript_updated':
      return {
        type: 'speech_started',
        segmentId: event.segmentId,
        at: event.at,
      };
  }
}

export class FloorController {
  private state = createInitialState();

  constructor(private readonly timeline?: InteractionTimeline) {}

  getState(now = Date.now()): FloorControllerState {
    this.expirePending(now);
    return this.readState();
  }

  preview(text: string, now = Date.now()): FloorPreview {
    this.expirePending(now);
    return {
      candidateText: normalizeText(text),
      pendingFragmentCount: this.state.pendingUserFloor.length,
      generation: this.state.generation,
    };
  }

  observeSignal(signal: TurnSignal): void {
    const at = isFiniteTimestamp(signal.at) ? signal.at : Date.now();
    this.expirePending(at);
    this.timeline?.record(createTimelineEventForSignal({ ...signal, at }));

    switch (signal.type) {
      case 'speech_started': {
        const previousOwner = this.state.floorOwner;
        this.state = {
          ...this.state,
          floorOwner: 'user',
          activeSegmentId: signal.segmentId,
        };
        if (previousOwner !== 'user') {
          this.timeline?.record({
            kind: 'floor_acquired',
            owner: 'user',
            at,
            segmentId: signal.segmentId,
          });
        }
        return;
      }
      case 'speech_ended':
        if (this.state.activeSegmentId === signal.segmentId) {
          this.state = { ...this.state, activeSegmentId: null };
        }
        return;
      case 'utterance_finalized':
        return;
      case 'recognition_failed':
        this.reset('recognition_failed', at);
        return;
      case 'recognition_stopped':
        this.reset('recognition_stopped', at);
        return;
    }
  }

  applyFinalized(
    text: string,
    decision: ConversationActionDecision,
    metadata: VoiceTurnMetadata,
  ): FloorTransition {
    const at = isFiniteTimestamp(metadata.at) ? metadata.at : Date.now();
    this.expirePending(at);
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      this.timeline?.record({
        kind: 'transcript_discarded',
        at,
        segmentId: metadata.segmentId,
        reason: 'empty-transcript',
      });
      return this.transition(null, null);
    }

    let action = decision.action;
    let reason: string | undefined;
    if (
      (action === 'listen' || action === 'backchannel') &&
      isContentBearingVoiceMessage(normalizedText)
    ) {
      const requestedAction = action;
      action = 'take_floor';
      reason = `content-bearing-${requestedAction}-guard`;
    }

    this.timeline?.record({
      kind: 'floor_action',
      action,
      at,
      segmentId: metadata.segmentId,
      pendingFragmentCount: this.state.pendingUserFloor.length,
      asrConfidence: normalizeConfidence(metadata.asrConfidence),
      ...(reason ? { reason } : {}),
    });

    if (action === 'listen') {
      const fragment: PendingUserFragment = {
        segmentId: metadata.segmentId,
        text: normalizedText.slice(0, MAX_PENDING_USER_TEXT_LENGTH),
        capturedAt: at,
        expiresAt: at + PENDING_USER_FLOOR_TTL_MS,
        asrConfidence: normalizeConfidence(metadata.asrConfidence),
      };
      this.state = {
        ...this.state,
        floorOwner: 'user',
        activeSegmentId: null,
        pendingUserFloor: appendPendingFragment(
          this.state.pendingUserFloor,
          fragment,
        ),
      };
      return this.transition(action, null);
    }

    if (action !== 'take_floor') {
      this.state = {
        ...this.state,
        floorOwner: 'user',
        activeSegmentId: null,
      };
      return this.transition(action, null);
    }

    const pendingFragmentCount = this.state.pendingUserFloor.length;
    if (pendingFragmentCount > 0) {
      this.timeline?.record({
        kind: 'pending_discarded',
        at,
        fragmentCount: pendingFragmentCount,
        reason: 'take-floor-current-utterance-only',
      });
    }
    this.state = {
      floorOwner: 'vayria',
      activeSegmentId: null,
      pendingUserFloor: [],
      generation: this.state.generation + 1,
    };
    this.timeline?.record({
      kind: 'floor_acquired',
      owner: 'vayria',
      at,
      segmentId: metadata.segmentId,
    });
    return this.transition(action, normalizedText, normalizedText);
  }

  release(reason: string, at = Date.now()): void {
    const owner = this.state.floorOwner;
    this.state = {
      ...this.state,
      floorOwner: 'none',
      activeSegmentId: null,
    };
    if (owner !== 'none') {
      this.timeline?.record({
        kind: 'floor_released',
        owner,
        at,
        reason: reason.slice(0, 120),
      });
    }
  }

  reset(reason: string, at = Date.now()): void {
    const hadPending = this.state.pendingUserFloor.length > 0;
    const owner = this.state.floorOwner;
    if (hadPending) {
      this.timeline?.record({
        kind: 'pending_discarded',
        at,
        fragmentCount: this.state.pendingUserFloor.length,
        reason: reason.slice(0, 120),
      });
    }
    this.state = {
      floorOwner: 'none',
      activeSegmentId: null,
      pendingUserFloor: [],
      generation: this.state.generation + 1,
    };
    if (hadPending || owner !== 'none') {
      this.timeline?.record({
        kind: 'floor_released',
        owner,
        at,
        reason: reason.slice(0, 120),
      });
    }
  }

  private expirePending(now: number): void {
    const expiredCount = this.state.pendingUserFloor.filter((fragment) =>
      hasExpired(fragment, now),
    ).length;
    if (!expiredCount) return;
    const pendingUserFloor = this.state.pendingUserFloor.filter(
      (fragment) => !hasExpired(fragment, now),
    );
    this.state = { ...this.state, pendingUserFloor };
    this.timeline?.record({
      kind: 'pending_expired',
      at: now,
      fragmentCount: expiredCount,
    });
  }

  private transition(
    action: ConversationAction | null,
    candidateText: string | null,
    committedText: string | null = null,
  ): FloorTransition {
    return {
      state: this.readState(),
      action,
      candidateText,
      committedText,
    };
  }

  private readState(): FloorControllerState {
    return {
      ...this.state,
      pendingUserFloor: this.state.pendingUserFloor.map((fragment) => ({
        ...fragment,
      })),
    };
  }
}

export function createFloorController(
  timeline?: InteractionTimeline,
): FloorController {
  return new FloorController(timeline);
}
