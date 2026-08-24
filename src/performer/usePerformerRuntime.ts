import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PERFORMER_PROFILE } from './profile.js';
import {
  applyDirectionModifiers,
  applyPlanLocalModifiers,
  applyTriggerToState,
  aggregateDirectionContributions,
  createActionIntent,
  createInitialPerformerState,
  createPerformerStateContext,
  decayPerformerState,
  reducePerformanceResult,
  resolvePerformancePlan,
  schedulePerformancePlan,
} from './runtime.js';
import type {
  DirectionContribution,
  PerformancePlan,
  PerformanceResult,
  PerformerProfile,
  PerformerState,
  PerformerTrigger,
} from './types.js';

export function usePerformerRuntime(
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
) {
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const [state, setState] = useState(() =>
    createInitialPerformerState(Date.now(), profile),
  );
  const stateRef = useRef(state);
  const activePlanIdRef = useRef<string | null>(null);
  const planProfileRef = useRef(new Map<string, PerformerProfile>());

  const updateState = useCallback((nextState: PerformerState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const createPlan = useCallback(
    (
      trigger: PerformerTrigger,
      contributions: readonly DirectionContribution[] = [],
      now = Date.now(),
    ): PerformancePlan => {
      const currentState = applyTriggerToState(
        stateRef.current,
        trigger,
        now,
        profileRef.current,
      );
      const aggregate = aggregateDirectionContributions(contributions, now);
      const effectiveProfile = applyDirectionModifiers(
        profileRef.current,
        aggregate.modifiers,
      );
      const intent = createActionIntent(
        trigger,
        applyPlanLocalModifiers(currentState, aggregate.modifiers),
        effectiveProfile,
      );
      const plan = resolvePerformancePlan(
        intent,
        contributions,
        currentState,
        profileRef.current,
        now,
      );
      planProfileRef.current.set(plan.planId, effectiveProfile);
      activePlanIdRef.current = plan.planId;
      updateState(schedulePerformancePlan(currentState, plan));
      return plan;
    },
    [updateState],
  );

  const completePlan = useCallback(
    (result: PerformanceResult) => {
      if (activePlanIdRef.current !== result.planId) return false;
      const effectiveProfile =
        planProfileRef.current.get(result.planId) ?? profileRef.current;
      const nextState = reducePerformanceResult(
        stateRef.current,
        result,
        effectiveProfile,
      );
      planProfileRef.current.delete(result.planId);
      activePlanIdRef.current = null;
      updateState(nextState);
      return true;
    },
    [updateState],
  );

  const resetRuntime = useCallback(() => {
    planProfileRef.current.clear();
    activePlanIdRef.current = null;
    updateState(createInitialPerformerState(Date.now(), profileRef.current));
  }, [updateState]);

  const setPhase = useCallback(
    (phase: PerformerState['phase']) => {
      updateState({
        ...decayPerformerState(stateRef.current, Date.now(), profileRef.current),
        phase,
      });
    },
    [updateState],
  );

  const getPerformerStateContext = useCallback(
    () => createPerformerStateContext(stateRef.current),
    [],
  );

  const cancelPlan = useCallback(
    (planId: string, completedAt = Date.now()) => {
      if (activePlanIdRef.current !== planId) return false;
      return completePlan({
        planId,
        completedAt,
        outcome: 'cancelled',
        trigger: 'external_stimulus',
        intent: 'wait',
      });
    },
    [completePlan],
  );

  return {
    state,
    createPlan,
    completePlan,
    cancelPlan,
    getPerformerStateContext,
    resetRuntime,
    setPhase,
  };
}
