import { useEffect, useRef, useState } from 'react';

export interface AutonomousSchedulerState {
  hasCandidate: boolean;
  isBusy: boolean;
  isVoiceActivityActive: boolean;
  isLoopEnabled: boolean;
  isMuted: boolean;
  isReady: boolean;
  isVisible: boolean;
}

export function shouldScheduleAutonomousTalk(
  state: AutonomousSchedulerState,
): boolean {
  return (
    state.hasCandidate &&
    !state.isMuted &&
    state.isLoopEnabled &&
    !state.isVoiceActivityActive &&
    state.isReady &&
    state.isVisible &&
    !state.isBusy
  );
}

interface UseAutonomousTalkOptions {
  cancelAutonomous: () => void;
  candidateKey: string | null;
  hasCandidate: boolean;
  isBusy: boolean;
  isVoiceActivityActive: boolean;
  isLoopEnabled: boolean;
  isMuted: boolean;
  isReady: boolean;
  sessionGeneration: number;
  onCandidate: () => Promise<boolean>;
}

/**
 * Dispatches an already admitted candidate when the runtime becomes ready.
 * Time passage alone never creates or dispatches a candidate.
 */
export function useAutonomousTalk({
  cancelAutonomous,
  candidateKey,
  hasCandidate,
  isBusy,
  isVoiceActivityActive,
  isLoopEnabled,
  isMuted,
  isReady,
  sessionGeneration,
  onCandidate,
}: UseAutonomousTalkOptions) {
  const [isVisible, setIsVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const dispatchedCandidateRef = useRef<string | null>(null);
  const onCandidateRef = useRef(onCandidate);

  useEffect(() => {
    onCandidateRef.current = onCandidate;
  }, [onCandidate]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      if (!visible) cancelAutonomous();
      setIsVisible(visible);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelAutonomous();
    };
  }, [cancelAutonomous]);

  useEffect(() => {
    if (!hasCandidate || !candidateKey) return;
    if (
      !shouldScheduleAutonomousTalk({
        hasCandidate,
        isBusy,
        isVoiceActivityActive,
        isLoopEnabled,
        isMuted,
        isReady,
        isVisible,
      })
    ) {
      return;
    }
    if (dispatchedCandidateRef.current === candidateKey) return;

    dispatchedCandidateRef.current = candidateKey;
    void onCandidateRef.current().catch(() => {
      // The candidate remains marked as evaluated until new evidence arrives.
    });
  }, [
    candidateKey,
    hasCandidate,
    isBusy,
    isVoiceActivityActive,
    isLoopEnabled,
    isMuted,
    isReady,
    isVisible,
    sessionGeneration,
  ]);
}
