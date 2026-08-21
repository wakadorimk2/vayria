import { useEffect, useRef, useState } from 'react';

export const INITIAL_AUTONOMOUS_DELAY_MS = 4_000;
export const AUTONOMOUS_MIN_DELAY_MS = 8_000;
export const AUTONOMOUS_MAX_DELAY_MS = 18_000;

interface UseAutonomousTalkOptions {
  cancelAutonomous: () => void;
  isBusy: boolean;
  isMuted: boolean;
  isReady: boolean;
  startAutonomous: () => Promise<boolean>;
}

function createAutonomousDelay(): number {
  return Math.round(
    AUTONOMOUS_MIN_DELAY_MS +
      Math.random() * (AUTONOMOUS_MAX_DELAY_MS - AUTONOMOUS_MIN_DELAY_MS),
  );
}

export function useAutonomousTalk({
  cancelAutonomous,
  isBusy,
  isMuted,
  isReady,
  startAutonomous,
}: UseAutonomousTalkOptions) {
  const [isVisible, setIsVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const initialDelayEligibleRef = useRef(true);
  const startAutonomousRef = useRef(startAutonomous);

  useEffect(() => {
    startAutonomousRef.current = startAutonomous;
  }, [startAutonomous]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      if (!visible) {
        initialDelayEligibleRef.current = false;
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
      initialDelayEligibleRef.current = false;
      cancelAutonomous();
      return;
    }
    if (!isReady || !isVisible || isBusy) return;

    const delay = initialDelayEligibleRef.current
      ? INITIAL_AUTONOMOUS_DELAY_MS
      : createAutonomousDelay();
    const timer = setTimeout(() => {
      initialDelayEligibleRef.current = false;
      void startAutonomousRef.current();
    }, delay);

    return () => clearTimeout(timer);
  }, [cancelAutonomous, isBusy, isMuted, isReady, isVisible]);
}
