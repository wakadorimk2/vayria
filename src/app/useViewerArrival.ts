import { useEffect, useRef } from 'react';
import { hasFreshViewerFace, ViewerArrivalController } from '../attention/viewerArrival';
import type { CameraAttentionSnapshot } from '../attention/cameraAttentionController';

/** Feed camera observations to the existing autonomy path only while available. */
export function useViewerArrival(options: {
  enabled: boolean;
  canSpeak: boolean;
  canNotice: boolean;
  sessionGeneration: number;
  readSnapshot: () => CameraAttentionSnapshot;
  readViewerInputSequence: () => number;
  onNotice: () => void;
  onArrival: () => void;
  onUnavailable: () => void;
}) {
  const current = useRef(options);
  useEffect(() => { current.current = options; });
  useEffect(() => {
    const controller = new ViewerArrivalController();
    let lastInputSequence = current.current.readViewerInputSequence();
    const timer = window.setInterval(() => {
      const state = current.current;
      const now = Date.now();
      const inputSequence = state.readViewerInputSequence();
      if (inputSequence !== lastInputSequence) {
        controller.consumeGreeting();
        lastInputSequence = inputSequence;
      }
      if (!state.enabled || document.hidden) {
        controller.pause();
        state.onUnavailable();
        return;
      }
      const visible = hasFreshViewerFace(state.readSnapshot(), now);
      if (!visible || !state.canSpeak) state.onUnavailable();
      const event = controller.update(now, visible, state.canSpeak, state.canNotice);
      if (event === 'notice') state.onNotice();
      if (event === 'arrival') state.onArrival();
    }, 250);
    return () => window.clearInterval(timer);
  }, [options.sessionGeneration]);
}
