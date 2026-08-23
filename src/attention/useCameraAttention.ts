import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CameraAttentionController,
  type CameraAttentionErrorCode,
  type CameraAttentionSnapshot,
  type CameraAttentionStatus,
} from './cameraAttentionController.js';

export interface UseCameraAttentionOptions {
  enabled?: boolean;
}

export interface CameraAttentionApi {
  status: CameraAttentionStatus | 'disabled';
  errorCode: CameraAttentionErrorCode | null;
  start: () => Promise<boolean>;
  stop: () => void;
  readSnapshot: () => CameraAttentionSnapshot;
}

const EMPTY_SNAPSHOT: CameraAttentionSnapshot = {
  position: null,
  confidence: 0,
  updatedAt: 0,
};

export function useCameraAttention(
  options: UseCameraAttentionOptions = {},
): CameraAttentionApi {
  const enabled = options.enabled ?? true;
  const controllerRef = useRef<CameraAttentionController | null>(null);
  const [state, setState] = useState({
    status: 'idle' as CameraAttentionStatus | 'disabled',
    errorCode: null as CameraAttentionErrorCode | null,
  });

  useEffect(() => {
    const controller = new CameraAttentionController({
      onStateChange: (nextState) => setState(nextState),
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.stop();
    };
  }, []);

  useEffect(() => {
    if (enabled) return;
    controllerRef.current?.stop();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handlePreferenceChange = () => {
      if (mediaQuery.matches) {
        controllerRef.current?.stop();
        setState({ status: 'disabled', errorCode: null });
      } else {
        setState((current) =>
          current.status === 'disabled'
            ? { status: 'idle', errorCode: null }
            : current,
        );
      }
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handlePreferenceChange);
    } else {
      mediaQuery.addListener(handlePreferenceChange);
    }
    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handlePreferenceChange);
      } else {
        mediaQuery.removeListener(handlePreferenceChange);
      }
    };
  }, [enabled]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      controllerRef.current?.stop();
      setState({ status: 'disabled', errorCode: null });
      return false;
    }
    return (await controllerRef.current?.start()) ?? false;
  }, [enabled]);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
  }, []);

  const readSnapshot = useCallback(() => {
    return controllerRef.current?.readSnapshot() ?? EMPTY_SNAPSHOT;
  }, []);

  return {
    status: state.status,
    errorCode: state.errorCode,
    start,
    stop,
    readSnapshot,
  };
}
