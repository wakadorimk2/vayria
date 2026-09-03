import type { BargeInState } from './audioLab.js';
import {
  BARGE_IN_STARTUP_DUCK_GUARD_MS,
  findKnownHallucinationPhrase,
} from './audioLab.js';
import {
  isContentBearingVoiceMessage,
  isDefiniteParticipationMessage,
  isDefiniteQuestionMessage,
  isDirectActionRequestMessage,
} from '../performer/runtime.js';
import {
  DEFAULT_CHARACTER_IDENTITY,
  resolveSelfName,
  type CharacterIdentity,
} from '../character/identity.js';
import { MAX_VOICE_TEXT_LENGTH } from './voiceInput.js';

export type BargeInEvent =
  | {
      type: 'speech_started';
      ttsPlaying: boolean;
      suppressDuck?: boolean;
      playbackAgeMs?: number;
    }
  | { type: 'transcript_finalized'; accepted: boolean }
  | { type: 'recognition_failed' }
  | { type: 'recognition_stopped' }
  | { type: 'timeout' }
  | { type: 'tts_stopped' }
  | { type: 'reset' };

export type BargeInEffect = 'duck' | 'interrupt' | 'restore' | 'suppress_duck';

export interface BargeInTransition {
  state: BargeInState;
  effects: BargeInEffect[];
  reason?: string;
}

export interface BargeInTranscriptOptions {
  characterIdentity?: CharacterIdentity;
  requireConversationalCue?: boolean;
}

const HIGH_CONFIDENCE_INTERRUPTION_PATTERN =
  /^(?:待って|ちょっと待って|いや|違う|やめて|止めて|聞いて|ねえ|ねぇ)(?:[、,，:：\s]|$)/u;

function restore(reason: string): BargeInTransition {
  return {
    state: 'restored',
    effects: ['restore'],
    reason,
  };
}

function isHighConfidenceBargeInCue(
  text: string,
  characterIdentity: CharacterIdentity,
): boolean {
  return Boolean(
    resolveSelfName(text, characterIdentity).role !== 'none' ||
      isDefiniteQuestionMessage(text) ||
      isDirectActionRequestMessage(text) ||
      isDefiniteParticipationMessage(text) ||
      HIGH_CONFIDENCE_INTERRUPTION_PATTERN.test(text),
  );
}

export function isConfirmedBargeInTranscript(
  text: string,
  options: BargeInTranscriptOptions = {},
): boolean {
  const normalized = text.normalize('NFKC').trim();
  if (
    !normalized ||
    normalized.length > MAX_VOICE_TEXT_LENGTH ||
    findKnownHallucinationPhrase(normalized) !== null
  ) {
    return false;
  }

  if (options.requireConversationalCue) {
    return isHighConfidenceBargeInCue(
      normalized,
      options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY,
    );
  }

  return isContentBearingVoiceMessage(normalized);
}

export function shouldInterruptBusyTurn(
  acceptedTranscript: boolean,
  isBusy: boolean,
  hasActivePlan: boolean,
): boolean {
  return acceptedTranscript && (isBusy || hasActivePlan);
}

export function shouldSuppressStartupDuck(
  ttsPlaying: boolean,
  isVoiceTurn: boolean,
  playbackAgeMs: number | null,
): boolean {
  return (
    ttsPlaying &&
    isVoiceTurn &&
    playbackAgeMs !== null &&
    Number.isFinite(playbackAgeMs) &&
    playbackAgeMs >= 0 &&
    playbackAgeMs <= BARGE_IN_STARTUP_DUCK_GUARD_MS
  );
}

export function isRejectedBargeInCandidate(
  candidateSegmentId: string | null,
  segmentId: string,
  transition: BargeInTransition | null,
): boolean {
  return (
    candidateSegmentId === segmentId &&
    !(transition?.effects.includes('interrupt') ?? false)
  );
}

export function reduceBargeIn(
  state: BargeInState,
  event: BargeInEvent,
): BargeInTransition {
  switch (event.type) {
    case 'speech_started':
      if (
        !event.ttsPlaying ||
        state === 'candidate' ||
        state === 'confirmed'
      ) {
        return { state, effects: [] };
      }
      return {
        state: 'candidate',
        effects: event.suppressDuck ? ['suppress_duck'] : ['duck'],
        reason: event.suppressDuck
          ? 'playback-startup-guard'
          : 'barge-in-candidate',
      };
    case 'transcript_finalized':
      if (state !== 'candidate') return { state, effects: [] };
      if (event.accepted) {
        return {
          state: 'confirmed',
          effects: ['interrupt', 'restore'],
          reason: 'confirmed-barge-in',
        };
      }
      return restore('candidate-rejected');
    case 'recognition_failed':
      return state === 'candidate'
        ? restore('recognition-failed')
        : { state, effects: [] };
    case 'recognition_stopped':
      return state === 'candidate'
        ? restore('recognition-stopped')
        : { state, effects: [] };
    case 'timeout':
      return state === 'candidate' ? restore('timeout') : { state, effects: [] };
    case 'tts_stopped':
      return state === 'candidate'
        ? { state, effects: ['restore'], reason: 'tts-stopped' }
        : { state, effects: [] };
    case 'reset':
      if (state === 'candidate') {
        return { state: 'idle', effects: ['restore'], reason: 'reset' };
      }
      return { state: 'idle', effects: [] };
  }
}
