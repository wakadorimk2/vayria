import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiUrl, runtimeConfig } from '../runtimeConfig';
import { createConversationEventEmitter } from './conversationEvents';
import { createConversationRuntime, type ConversationOptions } from './conversationRuntime';
import type { PerformancePlayback } from '../performer/performancePlayback';
export type * from './conversationRuntime';

export function useConversation(playback: PerformancePlayback, options: ConversationOptions = {}) {
  const [runtime] = useState(() => createConversationRuntime(playback, options, {
    fetch: (path, init) => fetch(apiUrl(String(path)), init),
    config: runtimeConfig,
    createEventEmitter: createConversationEventEmitter,
    now: Date.now,
    monotonicNow: () => performance.now(),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
    prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  useEffect(() => { runtime.updatePlayback(playback); }, [runtime, playback]);
  useEffect(() => { runtime.updateOptions(options); });
  useEffect(() => () => runtime.dispose(), [runtime]);
  const { cancelAutonomous, clearSubtitle, evaluateVoiceParticipation, interruptCurrentTurn,
    previewVoiceMessage, recordVoiceSignal, resetConversation, sendAutonomous, sendManual, sendVoice } = runtime;
  return {
    ...snapshot, cancelAutonomous, clearSubtitle, evaluateVoiceParticipation, interruptCurrentTurn,
    previewVoiceMessage, recordVoiceSignal, resetConversation, sendAutonomous, sendManual, sendVoice
  };
}
