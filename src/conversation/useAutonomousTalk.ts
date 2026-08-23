import { useEffect, useRef, useState } from 'react';

export const INITIAL_AUTONOMOUS_DELAY_MS = 4_000;
export const AUTONOMOUS_MIN_DELAY_MS = 8_000;
export const AUTONOMOUS_MAX_DELAY_MS = 18_000;

interface UseAutonomousTalkOptions {
  cancelAutonomous: () => void;
  getNextAutonomousDelay: () => number;
  isBusy: boolean;
  isVoiceInputActive: boolean;
  isLoopEnabled: boolean;
  isWaitingForViewer: boolean;
  isMuted: boolean;
  isReady: boolean;
  sessionGeneration: number;
  onIdleTick: () => Promise<boolean>;
}

export function useAutonomousTalk({
  cancelAutonomous,
  getNextAutonomousDelay,
  isBusy,
  isVoiceInputActive,
  isLoopEnabled,
  isWaitingForViewer,
  isMuted,
  isReady,
  sessionGeneration,
  onIdleTick,
}: UseAutonomousTalkOptions) {
  const [isVisible, setIsVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const onIdleTickRef = useRef(onIdleTick);
  const getNextAutonomousDelayRef = useRef(getNextAutonomousDelay);

  useEffect(() => {
    onIdleTickRef.current = onIdleTick;
    getNextAutonomousDelayRef.current = getNextAutonomousDelay;
  }, [getNextAutonomousDelay, onIdleTick]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      if (!visible) {
        cancelAutonomous();
      }
      setIsVisible(visible);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelAutonomous();
    };
  }, [cancelAutonomous]);

  useEffect(() => {
    if (isMuted) {
      cancelAutonomous();
      return;
    }
    if (isWaitingForViewer) {
      cancelAutonomous();
      return;
    }
    if (
      !isLoopEnabled ||
      isVoiceInputActive ||
      !isReady ||
      !isVisible ||
      isBusy
    ) {
      return;
    }

    const delay = Math.max(
      0,
      Math.round(getNextAutonomousDelayRef.current()),
    );
    const timer = setTimeout(() => {
      void onIdleTickRef.current()
        .then((shouldContinue) => {
          if (!shouldContinue) return;
          setScheduleVersion((current) => current + 1);
        })
        .catch(() => {
          // A failed autonomous tick stops the loop until the next manual action or reset.
        });
    }, delay);

    return () => clearTimeout(timer);
  }, [
    cancelAutonomous,
    isBusy,
    isVoiceInputActive,
    isLoopEnabled,
    isWaitingForViewer,
    isMuted,
    isReady,
    isVisible,
    scheduleVersion,
    sessionGeneration,
  ]);
}
