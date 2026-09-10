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
export function usePerformancePresentation({ activePlanRef, setActivePlan, setActiveEmotionCue, setIsAutonomousLoopEnabled, playbackCoordinator, completePlan, acceptReply, handlePerformancePlan, sessionGeneration, sessionGenerationRef }: { activePlanRef: React.RefObject<PerformancePlan | null>; setActivePlan: (plan: PerformancePlan | null) => void; setActiveEmotionCue: (cue: NonNullable<PerformanceResult['emotionCue']> | null) => void; setIsAutonomousLoopEnabled: (enabled: boolean) => void; playbackCoordinator: PerformancePlaybackCoordinator; completePlan: (result: PerformanceResult) => void; acceptReply: (ids: string[], swapRevision?: number) => void; handlePerformancePlan: (plan: PerformancePlan) => void; sessionGeneration: number; sessionGenerationRef: React.RefObject<number> }) {
  const cardDropReactionControllerRef = useRef(
    new CardDropReactionController(),
  );
  const cardReactionPlanIdsRef = useRef(new Set<string>());
  const cardDropReactionPlanIdsRef = useRef(new Set<string>());
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
      cardReactionPlanIdsRef.current.delete(
        result.planId,
      );
      if (result.outcome === 'failed') {
        setIsAutonomousLoopEnabled(false);
      }
      playbackCoordinator.stop();
      completePlan(result);
      activePlanRef.current = null;
      setActivePlan(null);
      setActiveEmotionCue(null);
    },
    [activePlanRef, completePlan, playbackCoordinator, setActiveEmotionCue, setActivePlan, setIsAutonomousLoopEnabled],
  );
  const handleReplyAccepted = useCallback(
    (activatedCardIds: string[], swapRevision?: number) => {
      acceptReply(activatedCardIds, swapRevision);
    },
    [acceptReply],
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
  return { cardDropReactionControllerRef, cardReactionPlanIdsRef, cardDropReactionPlanIdsRef, nonSpeechTimerRef, handlePerformanceResult, handleReplyAccepted, cancelActiveCardReactionPlan, executeNonSpeechPlan, cancelNonSpeechPlan };
}
