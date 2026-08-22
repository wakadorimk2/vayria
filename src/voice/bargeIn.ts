import type { BargeInState } from './audioLab.js';

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

export function reduceBargeIn(
  state: BargeInState,
  event: BargeInEvent,
): BargeInTransition {
  switch (event.type) {
    case 'speech_started':
      if (!event.ttsPlaying || state === 'ducked') {
        return { state, effects: [] };
      }
      return { state: 'ducked', effects: ['duck'], reason: 'speech-started' };
    case 'transcript_finalized':
      if (state !== 'ducked') return { state, effects: [] };
      if (event.accepted) {
        return {
          state: 'confirmed',
          effects: ['interrupt', 'restore'],
          reason: 'accepted-transcript',
        };
      }
      return restore('empty-or-filtered-transcript');
    case 'recognition_failed':
      return state === 'ducked'
        ? restore('recognition-failed')
        : { state, effects: [] };
    case 'recognition_stopped':
      return state === 'ducked'
        ? restore('recognition-stopped')
        : { state, effects: [] };
    case 'timeout':
      return state === 'ducked' ? restore('timeout') : { state, effects: [] };
    case 'tts_stopped':
      return state === 'ducked' ? restore('tts-stopped') : { state, effects: [] };
    case 'reset':
      if (state === 'ducked') {
        return { state: 'idle', effects: ['restore'], reason: 'reset' };
      }
      return { state: 'idle', effects: [] };
  }
}
