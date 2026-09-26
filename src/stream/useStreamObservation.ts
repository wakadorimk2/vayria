import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StreamObserver,
  type StreamEvidenceInput,
  type StreamObserverStatus,
} from './streamObserver.js';
import type { StreamObservation } from './streamContract.js';

export interface UseStreamObservationOptions {
  enabled: boolean;
  onEvidence: (evidence: StreamEvidenceInput) => void;
  onObservation?: (observation: StreamObservation) => void;
}

export interface UseStreamObservationResult {
  status: StreamObserverStatus;
  captureError: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

const idleStatus: StreamObserverStatus = {
  running: false,
  capturing: false,
  lastFrameAt: null,
  lastObserveAt: null,
  lastChangeAt: null,
  consecutiveErrors: 0,
  lastError: null,
  lastObservation: null,
};

// Manual-start stream observation: the player clicks "share screen",
// the observer samples short frame windows and feeds game events into
// the autonomy evidence pipeline. Stops cleanly on unmount or when
// the mode is disabled.
export function useStreamObservation({
  enabled,
  onEvidence,
  onObservation,
}: UseStreamObservationOptions): UseStreamObservationResult {
  const observerRef = useRef<StreamObserver | null>(null);
  const onEvidenceRef = useRef(onEvidence);
  const onObservationRef = useRef(onObservation);
  useEffect(() => {
    onEvidenceRef.current = onEvidence;
    onObservationRef.current = onObservation;
  }, [onEvidence, onObservation]);
  const [status, setStatus] = useState<StreamObserverStatus>(idleStatus);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const stop = useCallback(() => {
    observerRef.current?.stop();
    observerRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (observerRef.current) return;
    setCaptureError(null);
    const observer = new StreamObserver({
      onEvidence: (evidence) => onEvidenceRef.current(evidence),
      onObservation: (observation) => onObservationRef.current?.(observation),
      onStatus: setStatus,
    });
    observerRef.current = observer;
    try {
      await observer.start();
    } catch (error) {
      observerRef.current = null;
      setCaptureError(
        error instanceof Error ? error.message : 'Screen share was denied.',
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) stop();
    return () => {
      observerRef.current?.stop();
      observerRef.current = null;
    };
  }, [enabled, stop]);

  return { status, captureError, start, stop };
}
