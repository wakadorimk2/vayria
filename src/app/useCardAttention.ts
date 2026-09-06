import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { AttentionEnergyController } from '../attention/attentionEnergyController';
import {
  DRAG_ATTENTION_TICK_MS,
  DragAttentionController,
} from '../attention/dragAttentionController';
import { SpatialTargetRegistry } from '../attention/spatialTargetRegistry';
import {
  CARD_INTERACTION_ATTENTION_DURATION_MS
} from '../cards/cardReactions';
function readAnimationNow(): number { return typeof performance !== "undefined" && Number.isFinite(performance.now()) ? performance.now() : Date.now(); }
export function useCardAttention({ spatialTargetRegistry }: { spatialTargetRegistry: SpatialTargetRegistry }) {
  const [cardAttentionPhase, setCardAttentionPhase] = useState<
    'transient' | 'default' | 'drag-acquire' | 'drag-priority' | null
  >(null);
  const spatialTargetDisposeTimerRef = useRef<number | null>(null);
  const cardAttentionTimerRef = useRef<number | null>(null);
  const cardAttentionStartedAtRef = useRef<number | null>(null);
  const cardAttentionFallbackTimerRef = useRef<number | null>(null);
  const dragAttentionTickRef = useRef<number | null>(null);
  const dragAttentionLastTickAtRef = useRef<number | null>(null);
  const dragAttentionSpeedRef = useRef<{
    speedPxPerSecond: number;
    capturedAt: number;
  } | null>(null);
  const dragAttentionControllerRef = useRef(new DragAttentionController());
  const cardAttentionEnergyControllerRef = useRef(
    new AttentionEnergyController(),
  );
  const clearCardAttentionTimers = useCallback(() => {
    if (cardAttentionTimerRef.current !== null) {
      window.clearTimeout(cardAttentionTimerRef.current);
      cardAttentionTimerRef.current = null;
    }
    if (cardAttentionFallbackTimerRef.current !== null) {
      window.clearTimeout(cardAttentionFallbackTimerRef.current);
      cardAttentionFallbackTimerRef.current = null;
    }
    if (dragAttentionTickRef.current !== null) {
      window.clearInterval(dragAttentionTickRef.current);
      dragAttentionTickRef.current = null;
    }
    dragAttentionLastTickAtRef.current = null;
  }, []);
  const scheduleDragAttentionTick = useCallback(() => {
    if (dragAttentionTickRef.current !== null) return;

    dragAttentionTickRef.current = window.setInterval(() => {
      const now = readAnimationNow();
      const previous = dragAttentionLastTickAtRef.current ?? now;
      dragAttentionLastTickAtRef.current = now;
      const movement = dragAttentionSpeedRef.current;
      const speedPxPerSecond =
        movement && now - movement.capturedAt <= 160
          ? movement.speedPxPerSecond
          : 0;
      const snapshot = dragAttentionControllerRef.current.update(
        Math.max(0, now - previous),
        Math.random,
        speedPxPerSecond,
      );
      if (snapshot.phase === 'idle') {
        clearCardAttentionTimers();
        return;
      }

      setCardAttentionPhase(
        snapshot.phase === 'priority' ? 'drag-priority' : 'drag-acquire',
      );
    }, DRAG_ATTENTION_TICK_MS);
  }, [clearCardAttentionTimers]);
  const scheduleCardAttentionSequence = useCallback(
    (transientDurationMs: number) => {
      clearCardAttentionTimers();
      cardAttentionStartedAtRef.current = readAnimationNow();
      setCardAttentionPhase('transient');

      const transientTimerId = window.setTimeout(() => {
        if (cardAttentionTimerRef.current !== transientTimerId) return;
        cardAttentionTimerRef.current = null;
        setCardAttentionPhase('default');

        const defaultTimerId = window.setTimeout(() => {
          if (cardAttentionFallbackTimerRef.current !== defaultTimerId) {
            return;
          }
          cardAttentionFallbackTimerRef.current = null;
          spatialTargetRegistry.clearTransient('game');
          cardAttentionEnergyControllerRef.current.clear();
          cardAttentionStartedAtRef.current = null;
          setCardAttentionPhase(null);
        }, CARD_INTERACTION_ATTENTION_DURATION_MS);
        cardAttentionFallbackTimerRef.current = defaultTimerId;
      }, Math.max(0, transientDurationMs));
      cardAttentionTimerRef.current = transientTimerId;
    },
    [clearCardAttentionTimers, spatialTargetRegistry],
  );
  const scheduleCardDefaultAttention = useCallback(() => {
    clearCardAttentionTimers();
    spatialTargetRegistry.clearTransient('game');
    cardAttentionStartedAtRef.current = readAnimationNow();
    setCardAttentionPhase('default');

    const defaultTimerId = window.setTimeout(() => {
      if (cardAttentionFallbackTimerRef.current !== defaultTimerId) return;
      cardAttentionFallbackTimerRef.current = null;
      cardAttentionEnergyControllerRef.current.clear();
      cardAttentionStartedAtRef.current = null;
      setCardAttentionPhase(null);
    }, CARD_INTERACTION_ATTENTION_DURATION_MS);
    cardAttentionFallbackTimerRef.current = defaultTimerId;
  }, [clearCardAttentionTimers, spatialTargetRegistry]);
  const finishDragAttention = useCallback(() => {
    const previousSnapshot = dragAttentionControllerRef.current.snapshot();
    const wasActive = previousSnapshot.phase !== 'idle';
    dragAttentionControllerRef.current.end();
    dragAttentionSpeedRef.current = null;
    spatialTargetRegistry.setTransientDragActive('game', false);
    clearCardAttentionTimers();
    cardAttentionStartedAtRef.current = null;
    if (!wasActive) return;
    cardAttentionEnergyControllerRef.current.clear();
    spatialTargetRegistry.clearTransient('game');
    setCardAttentionPhase(null);
  }, [
    clearCardAttentionTimers,
    spatialTargetRegistry,
  ]);
  useEffect(() => {
    if (spatialTargetDisposeTimerRef.current !== null) {
      window.clearTimeout(spatialTargetDisposeTimerRef.current);
      spatialTargetDisposeTimerRef.current = null;
    }
    const controller = dragAttentionControllerRef.current;
    const energyController = cardAttentionEnergyControllerRef.current;
    return () => {
      controller.end();
      dragAttentionSpeedRef.current = null;
      energyController.clear();
      cardAttentionStartedAtRef.current = null;
      clearCardAttentionTimers();
      const disposeTimerId = window.setTimeout(() => {
        if (spatialTargetDisposeTimerRef.current !== disposeTimerId) return;
        spatialTargetDisposeTimerRef.current = null;
        spatialTargetRegistry.dispose();
      }, 0);
      spatialTargetDisposeTimerRef.current = disposeTimerId;
    };
  }, [
    clearCardAttentionTimers,
    spatialTargetRegistry,
  ]);
  return { cardAttentionPhase, setCardAttentionPhase, spatialTargetDisposeTimerRef, cardAttentionTimerRef, cardAttentionStartedAtRef, cardAttentionFallbackTimerRef, dragAttentionTickRef, dragAttentionLastTickAtRef, dragAttentionSpeedRef, dragAttentionControllerRef, cardAttentionEnergyControllerRef, clearCardAttentionTimers, scheduleDragAttentionTick, scheduleCardAttentionSequence, scheduleCardDefaultAttention, finishDragAttention };
}
