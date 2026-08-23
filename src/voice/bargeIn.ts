import type { BargeInState } from './audioLab.js';
import { findKnownHallucinationPhrase } from './audioLab.js';
import { isContentBearingVoiceMessage } from '../performer/runtime.js';
import { MAX_VOICE_TEXT_LENGTH } from './voiceInput.js';

export type BargeInEvent =
  | { type: 'speech_started'; ttsPlaying: boolean }
  | { type: 'transcript_finalized'; accepted: boolean }
  | { type: 'recognition_failed' }
  | { type: 'recognition_stopped' }
  | { type: 'timeout' }
  | { type: 'tts_stopped' }
  | { type: 'reset' };

export type BargeInEffect = 'duck' | 'interrupt' | 'restore';

export interface BargeInTransition {
  state: BargeInState;
  effects: BargeInEffect[];
  reason?: string;
}

function restore(reason: string): BargeInTransition {
  return {
    state: 'restored',
    effects: ['restore'],
    reason,
  };
}

export function isConfirmedBargeInTranscript(text: string): boolean {
  const normalized = text.normalize('NFKC').trim();
  return Boolean(
    normalized &&
      normalized.length <= MAX_VOICE_TEXT_LENGTH &&
      findKnownHallucinationPhrase(normalized) === null &&
      isContentBearingVoiceMessage(normalized),
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
        effects: ['duck'],
        reason: 'barge-in-candidate',
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
        ? restore('tts-stopped')
        : { state, effects: [] };
    case 'reset':
      if (state === 'candidate') {
        return { state: 'idle', effects: ['restore'], reason: 'reset' };
      }
      return { state: 'idle', effects: [] };
  }
}
