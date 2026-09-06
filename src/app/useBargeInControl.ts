import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import {
  BARGE_IN_TIMEOUT_MS,
  type AudioLabMode,
  type BargeInState
} from '../voice/audioLab.js';
import {
  reduceBargeIn,
  type BargeInEvent
} from '../voice/bargeIn';
import { useVoiceLab } from '../voice/useVoiceLab';

export function useBargeInControl({ setDucked, voiceLab, ttsPlaying, handleInteractionTimelineEvent, audioLabMode }: { setDucked: (value: boolean) => void; voiceLab: ReturnType<typeof useVoiceLab>; ttsPlaying: boolean; handleInteractionTimelineEvent: (event: import('../conversation/interactionTimeline').InteractionTimelineEvent) => void; audioLabMode: AudioLabMode }) {
  const activeBargeInSegmentRef = useRef<string | null>(null);
  const bargeInTimerRef = useRef<number | null>(null);
  const bargeInStateRef = useRef<BargeInState>('idle');
  const [bargeInState, setBargeInState] = useState<BargeInState>('idle');
  const [bargeInTimeoutToken, setBargeInTimeoutToken] = useState(0);
  const clearBargeInTimer = useCallback(() => {
    if (bargeInTimerRef.current === null) return;
    window.clearTimeout(bargeInTimerRef.current);
    bargeInTimerRef.current = null;
  }, []);
  const dispatchBargeIn = useCallback(
    (event: BargeInEvent) => {
      const previousState = bargeInStateRef.current;
      const transition = reduceBargeIn(previousState, event);
      bargeInStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setBargeInState(transition.state);
      }

      if (transition.effects.includes('duck')) {
        clearBargeInTimer();
        setDucked(true);
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'duck',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
        bargeInTimerRef.current = window.setTimeout(() => {
          bargeInTimerRef.current = null;
          setBargeInTimeoutToken((token) => token + 1);
        }, BARGE_IN_TIMEOUT_MS);
      }

      if (transition.effects.includes('suppress_duck')) {
        const playbackAgeMs =
          event.type === 'speech_started' ? event.playbackAgeMs : undefined;
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'suppress_duck',
          state: transition.state,
          ttsPlaying,
          ...(playbackAgeMs === undefined ? {} : { playbackAgeMs }),
          reason: transition.reason,
        });
      }

      if (transition.effects.includes('interrupt')) {
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'interrupt',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
      }

      if (transition.effects.includes('restore')) {
        clearBargeInTimer();
        setDucked(false);
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'restore',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
      }

      if (transition.effects.length > 0) {
        handleInteractionTimelineEvent({
          kind: 'barge_in',
          at: Date.now(),
          action: transition.effects.join('+'),
          state: transition.state,
          ...(transition.reason ? { reason: transition.reason } : {}),
        });
      }

      return transition;
    },
    [
      clearBargeInTimer,
      handleInteractionTimelineEvent,
      setDucked,
      ttsPlaying,
      voiceLab,
    ],
  );
  const latestDispatchBargeInRef = useRef(dispatchBargeIn);
  useEffect(() => {
    latestDispatchBargeInRef.current = dispatchBargeIn;
  }, [dispatchBargeIn]);
  useEffect(() => {
    if (bargeInTimeoutToken === 0) return;
    dispatchBargeIn({ type: 'timeout' });
  }, [bargeInTimeoutToken, dispatchBargeIn]);
  useEffect(() => {
    if (ttsPlaying) return;
    if (bargeInStateRef.current !== 'candidate') return;
    dispatchBargeIn({ type: 'tts_stopped' });
  }, [dispatchBargeIn, ttsPlaying]);
  useEffect(() => {
    clearBargeInTimer();
    activeBargeInSegmentRef.current = null;
    if (bargeInStateRef.current === 'idle') return;
    latestDispatchBargeInRef.current({ type: 'reset' });
  }, [audioLabMode, clearBargeInTimer]);
  return { activeBargeInSegmentRef, bargeInTimerRef, bargeInStateRef, bargeInState, setBargeInState, bargeInTimeoutToken, setBargeInTimeoutToken, clearBargeInTimer, dispatchBargeIn, latestDispatchBargeInRef };
}
