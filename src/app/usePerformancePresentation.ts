import {
  useCallback,
  useRef
} from 'react';
import { CardDropReactionController } from '../cards/cardDropReaction';
import { PerformancePlaybackCoordinator } from '../performer/performancePlayback';
import type {
  PerformancePlan,
  PerformanceResult
} from '../performer/types';
export function usePerformancePresentation({ activePlanRef, setActivePlan, setActiveEmotionCue, setIsAutonomousLoopEnabled, playbackCoordinator, completePlan, acceptReply, resetTurn, handlePerformancePlan, sessionGeneration, sessionGenerationRef }: { activePlanRef: React.RefObject<PerformancePlan | null>; setActivePlan: (plan: PerformancePlan | null) => void; setActiveEmotionCue: (cue: NonNullable<PerformanceResult['emotionCue']> | null) => void; setIsAutonomousLoopEnabled: (enabled: boolean) => void; playbackCoordinator: PerformancePlaybackCoordinator; completePlan: (result: PerformanceResult) => void; acceptReply: (ids: string[]) => void; resetTurn: () => void; handlePerformancePlan: (plan: PerformancePlan) => void; sessionGeneration: number; sessionGenerationRef: React.RefObject<number> }) {
  const cardDropReactionControllerRef = useRef(
    new CardDropReactionController(),
  );
  const cardReactionPlanIdsRef = useRef(new Set<string>());
  const cardDropReactionPlanIdsRef = useRef(new Set<string>());
  const pendingActivatedCardIdsRef = useRef(new Map<string, string[]>());
  const nonSpeechTimerRef = useRef<number | null>(null);
  const handlePerformanceResult = useCallback(
    (result: PerformanceResult) => {
      const isCardDropReactionPlan = cardDropReactionPlanIdsRef.current.delete(
        result.planId,
      );
      if (isCardDropReactionPlan) {
        cardDropReactionControllerRef.current.settleReaction(
          result.planId,
          result.outcome,
        );
      }
      cardDropReactionControllerRef.current.settleReply(result.planId);
      if (activePlanRef.current?.planId !== result.planId) return;
      const isCardReactionPlan = cardReactionPlanIdsRef.current.delete(
        result.planId,
      );
      const pendingActivatedCardIds = pendingActivatedCardIdsRef.current.get(
        result.planId,
      );
      pendingActivatedCardIdsRef.current.delete(result.planId);
      if (result.outcome === 'failed') {
        setIsAutonomousLoopEnabled(false);
      }
      playbackCoordinator.stop();
      completePlan(result);
      if (isCardReactionPlan) {
        if (result.outcome === 'completed' && pendingActivatedCardIds) {
          acceptReply(pendingActivatedCardIds);
        } else {
          resetTurn();
        }
      }
      activePlanRef.current = null;
      setActivePlan(null);
      setActiveEmotionCue(null);
    },
    [acceptReply, activePlanRef, completePlan, playbackCoordinator, resetTurn, setActiveEmotionCue, setActivePlan, setIsAutonomousLoopEnabled],
  );
  const handleReplyAccepted = useCallback(
    (activatedCardIds: string[]) => {
      const planId = activePlanRef.current?.planId;
      if (planId && cardReactionPlanIdsRef.current.has(planId)) {
        pendingActivatedCardIdsRef.current.set(planId, activatedCardIds);
        return;
      }
      acceptReply(activatedCardIds);
    },
    [acceptReply, activePlanRef],
  );
  const cancelActiveCardReactionPlan = useCallback(() => {
    const plan = activePlanRef.current;
    if (!plan || !cardReactionPlanIdsRef.current.has(plan.planId)) {
      return false;
    }
    handlePerformanceResult({
      planId: plan.planId,
      completedAt: Date.now(),
      outcome: 'cancelled',
      trigger: plan.trigger,
      intent: plan.intent,
    });
    return true;
  }, [activePlanRef, handlePerformanceResult]);
  const executeNonSpeechPlan = useCallback(
    (plan: PerformancePlan) => {
      const expectedSessionGeneration = sessionGeneration;
      handlePerformancePlan(plan);
      if (nonSpeechTimerRef.current !== null) {
        window.clearTimeout(nonSpeechTimerRef.current);
      }
      const timer = window.setTimeout(() => {
        if (nonSpeechTimerRef.current === timer) {
          nonSpeechTimerRef.current = null;
        }
        if (expectedSessionGeneration !== sessionGenerationRef.current) return;
        handlePerformanceResult({
          planId: plan.planId,
          completedAt: Date.now(),
          outcome: 'completed',
          trigger: plan.trigger,
          intent: plan.intent,
          interactionAction: plan.actionDecision?.action,
        });
      }, plan.preReaction?.leadBeforeSpeechMs ?? 0);
      nonSpeechTimerRef.current = timer;
      return true;
    },
    [handlePerformancePlan, handlePerformanceResult, sessionGeneration, sessionGenerationRef],
  );
  const cancelNonSpeechPlan = useCallback(() => {
    if (nonSpeechTimerRef.current === null) return;

    window.clearTimeout(nonSpeechTimerRef.current);
    nonSpeechTimerRef.current = null;
    const plan = activePlanRef.current;
    if (!plan) return;

    handlePerformanceResult({
      planId: plan.planId,
      completedAt: Date.now(),
      outcome: 'cancelled',
      trigger: plan.trigger,
      intent: plan.intent,
      interactionAction: plan.actionDecision?.action,
    });
  }, [activePlanRef, handlePerformanceResult]);
  return { cardDropReactionControllerRef, cardReactionPlanIdsRef, cardDropReactionPlanIdsRef, pendingActivatedCardIdsRef, nonSpeechTimerRef, handlePerformanceResult, handleReplyAccepted, cancelActiveCardReactionPlan, executeNonSpeechPlan, cancelNonSpeechPlan };
}
