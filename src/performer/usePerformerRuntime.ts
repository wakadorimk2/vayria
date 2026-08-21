import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PERFORMER_PROFILE } from './profile';
import {
  applyDirectionModifiers,
  applyTriggerToState,
  aggregateDirectionContributions,
  createActionIntent,
  createInitialPerformerState,
  decayPerformerState,
  getNextAutonomousDelay as getDelay,
  reducePerformanceResult,
  resolvePerformancePlan,
} from './runtime';
import type {
  DirectionContribution,
  PerformancePlan,
  PerformanceResult,
  PerformerProfile,
  PerformerState,
  PerformerTrigger,
} from './types';

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
  const autonomousStartedRef = useRef(false);

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
        currentState,
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
      updateState({
        ...currentState,
        energy: Math.max(
          0,
          Math.min(1, currentState.energy + aggregate.modifiers.energy),
        ),
        attention: {
          ...currentState.attention,
          strength: Math.max(
            0,
            Math.min(1, currentState.attention.strength + aggregate.modifiers.attentionStrength),
          ),
        },
        phase:
          plan.intent === 'speak' || plan.intent === 'react_nonverbally'
            ? 'scheduled'
            : 'waiting',
      });
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

  const setPhase = useCallback(
    (phase: PerformerState['phase']) => {
      updateState({
        ...decayPerformerState(stateRef.current, Date.now(), profileRef.current),
        phase,
      });
    },
    [updateState],
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

  const getNextAutonomousDelay = useCallback(
    (contributions: readonly DirectionContribution[] = []) => {
      const now = Date.now();
      const aggregate = aggregateDirectionContributions(contributions, now);
      const effectiveProfile = applyDirectionModifiers(
        profileRef.current,
        aggregate.modifiers,
      );
      const nextDelay = getDelay(
        stateRef.current,
        effectiveProfile,
        !autonomousStartedRef.current,
      );
      autonomousStartedRef.current = true;
      return nextDelay;
    },
    [],
  );

  return {
    state,
    createPlan,
    completePlan,
    cancelPlan,
    getNextAutonomousDelay,
    setPhase,
  };
}
