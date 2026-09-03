import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAutonomyTurnGateState,
  getAutonomyTurnGateWaitMs,
  isAutonomyTurnGateReady,
  readAutonomyTimingSnapshot,
  transitionAutonomyTurnGate,
  type AutonomyTurnGateAction,
  type AutonomyTurnGateBlockReason,
  type AutonomyTurnGateExternalEvent,
  type AutonomyTurnGateState,
  type AutonomyTurnGateTelemetry,
  type AutonomyTurnGateTiming,
  type AutonomyTimingMode,
} from './autonomyTurnGate.js';

export type AutonomousTurnOutcome = 'speak' | 'none' | 'aborted';

export interface AutonomousSchedulerState {
  hasCandidate: boolean;
  isBusy: boolean;
  isVoiceActivityActive: boolean;
  isLoopEnabled: boolean;
  isMuted: boolean;
  isReady: boolean;
  isVisible: boolean;
  isTurnGateReady: boolean;
}

export function shouldScheduleAutonomousTalk(
  state: AutonomousSchedulerState,
): boolean {
  return (
    state.hasCandidate &&
    state.isTurnGateReady &&
    !state.isMuted &&
    state.isLoopEnabled &&
    !state.isVoiceActivityActive &&
    state.isReady &&
    state.isVisible &&
    !state.isBusy
  );
}

export interface AutonomyExternalEventSignal {
  sequence: number;
  kind: AutonomyTurnGateExternalEvent;
}

export interface AutonomyCandidateTelemetry {
  episodeId: string;
  reasonIds: readonly string[];
  decisionEvidenceIds: readonly string[];
}

interface UseAutonomousTalkOptions {
  cancelAutonomous: () => void;
  candidateKey: string | null;
  candidateTelemetry: AutonomyCandidateTelemetry | null;
  externalEventSignal: AutonomyExternalEventSignal | null;
  hasCandidate: boolean;
  isBusy: boolean;
  isVoiceActivityActive: boolean;
  isLoopEnabled: boolean;
  isMuted: boolean;
  isReady: boolean;
  onCandidate: () => Promise<AutonomousTurnOutcome>;
  onGateEvent?: (event: AutonomyTurnGateTelemetry) => void;
  now?: () => number;
  random?: () => number;
  sessionGeneration: number;
  timing: AutonomyTurnGateTiming;
  timingMode?: AutonomyTimingMode;
}

function readBlockReason(
  state: AutonomousSchedulerState,
  gate: AutonomyTurnGateState,
): AutonomyTurnGateBlockReason | null {
  if (gate.phase === 'initial_quiet') return 'initial_quiet';
  if (gate.phase === 'refractory') return 'refractory';
  if (gate.phase === 'running') return 'running';
  if (state.isBusy) return 'busy';
  if (state.isVoiceActivityActive) return 'voice_activity';
  if (!state.isLoopEnabled) return 'loop_disabled';
  if (state.isMuted) return 'muted';
  if (!state.isReady) return 'not_ready';
  if (!state.isVisible) return 'hidden';
  return null;
}

function readTransition(
  previous: AutonomyTurnGateState,
  next: AutonomyTurnGateState,
): AutonomyTurnGateTelemetry['transition'] {
  if (previous.phase !== next.phase) {
    if (next.phase === 'running') return 'entered_running';
    if (next.phase === 'refractory') return 'entered_refractory';
    if (next.phase === 'ready') {
      return previous.nextEligibleAt === null ? 'reopened' : 'timer_expired';
    }
  }
  return 'ignored';
}

/**
 * Holds an already selected autonomy candidate until the turn gate allows a
 * new autonomous evaluation. The timer changes gate state only; candidate
 * selection remains owned by App and autonomyState.
 */
export function useAutonomousTalk({
  cancelAutonomous,
  candidateKey,
  candidateTelemetry,
  externalEventSignal,
  hasCandidate,
  isBusy,
  isVoiceActivityActive,
  isLoopEnabled,
  isMuted,
  isReady,
  onCandidate,
  onGateEvent,
  now = Date.now,
  random = Math.random,
  sessionGeneration,
  timing,
  timingMode = 'baseline',
}: UseAutonomousTalkOptions) {
  const [isVisible, setIsVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const [gateState, setGateState] = useState<AutonomyTurnGateState>(() =>
    createAutonomyTurnGateState(now(), timing),
  );
  const gateStateRef = useRef(gateState);
  const timingRef = useRef(timing);
  const timingModeRef = useRef(timingMode);
  const nowRef = useRef(now);
  const randomRef = useRef(random);
  const onCandidateRef = useRef(onCandidate);
  const onGateEventRef = useRef(onGateEvent);
  const candidateTelemetryRef = useRef(candidateTelemetry);
  const activeCandidateTelemetryRef = useRef<AutonomyCandidateTelemetry | null>(
    null,
  );
  const dispatchedCandidateRef = useRef<string | null>(null);
  const lastCandidateKeyRef = useRef<string | null>(null);
  const lastDecisionKeyRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(sessionGeneration);
  const externalEventSequenceRef = useRef(externalEventSignal?.sequence ?? 0);
  const lastSkippedOpportunityRef = useRef<string | null>(null);

  useEffect(() => {
    timingRef.current = timing;
  }, [
    timing,
    timing.autonomyQuietTimeMaxMs,
    timing.autonomyQuietTimeMinMs,
    timing.initialAutonomyDelayMs,
  ]);

  useEffect(() => {
    timingModeRef.current = timingMode;
    nowRef.current = now;
    randomRef.current = random;
  }, [now, random, timingMode]);

  useEffect(() => {
    onCandidateRef.current = onCandidate;
  }, [onCandidate]);

  useEffect(() => {
    onGateEventRef.current = onGateEvent;
  }, [onGateEvent]);

  useEffect(() => {
    candidateTelemetryRef.current = candidateTelemetry;
  }, [candidateTelemetry]);

  const emitGateEvent = useCallback(
    (
      event: Omit<AutonomyTurnGateTelemetry, 'gatePhase'> & {
        gatePhase?: AutonomyTurnGateTelemetry['gatePhase'];
      },
      candidateOverride?: AutonomyCandidateTelemetry | null,
    ) => {
      const candidate = candidateOverride ?? candidateTelemetryRef.current;
      const observedAt = nowRef.current();
      const timingSnapshot = readAutonomyTimingSnapshot(
        gateStateRef.current,
        timingRef.current,
        observedAt,
        timingModeRef.current,
      );
      onGateEventRef.current?.({
        ...event,
        gatePhase: event.gatePhase ?? gateStateRef.current.phase,
        timingMode: timingModeRef.current,
        elapsedSilenceMs: timingSnapshot.elapsedSilenceMs,
        readiness: timingSnapshot.readiness,
        ...(timingSnapshot.threshold === null
          ? {}
          : { threshold: timingSnapshot.threshold }),
        sessionGeneration: sessionGenerationRef.current,
        ...(candidate
          ? {
              candidateEpisodeId: candidate.episodeId,
              candidateReasonIds: candidate.reasonIds,
              candidateEvidenceIds: candidate.decisionEvidenceIds,
            }
          : {}),
      });
    },
    [],
  );

  const applyGateAction = useCallback(
    (action: AutonomyTurnGateAction) => {
      const previous = gateStateRef.current;
      const next = transitionAutonomyTurnGate(
        previous,
        action,
        timingRef.current,
        randomRef.current,
        timingModeRef.current,
      );
      if (next === previous) return { changed: false, next };
      gateStateRef.current = next;
      setGateState(next);
      return { changed: true, next, previous };
    },
    [],
  );

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
    if (sessionGenerationRef.current === sessionGeneration) return;
    sessionGenerationRef.current = sessionGeneration;
    const next = createAutonomyTurnGateState(nowRef.current(), timingRef.current);
    gateStateRef.current = next;
    setGateState(next);
    dispatchedCandidateRef.current = null;
    activeCandidateTelemetryRef.current = null;
    lastCandidateKeyRef.current = null;
    lastDecisionKeyRef.current = null;
    lastSkippedOpportunityRef.current = null;
    emitGateEvent({
      gateEvent: 'session_reset',
      gatePhase: next.phase,
      nextEligibleAt: next.nextEligibleAt,
    });
  }, [emitGateEvent, sessionGeneration]);

  useEffect(() => {
    const sequence = externalEventSignal?.sequence ?? 0;
    if (sequence <= externalEventSequenceRef.current) return;
    externalEventSequenceRef.current = sequence;
    const event = externalEventSignal?.kind;
    if (!event) return;

    const result = applyGateAction({
      type: 'external_event',
      event,
      at: nowRef.current(),
    });
    emitGateEvent({
      gateEvent: 'external_event',
      gatePhase: result.next.phase,
      transition: result.changed
        ? result.next.phase === 'refractory'
          ? 'restarted'
          : 'reopened'
        : 'ignored',
      externalEvent: event,
      nextEligibleAt: result.next.nextEligibleAt,
    });
  }, [applyGateAction, emitGateEvent, externalEventSignal]);

  useEffect(() => {
    const waitMs = getAutonomyTurnGateWaitMs(gateState);
    if (waitMs === null) return;

    const timer = window.setTimeout(() => {
      const previous = gateStateRef.current;
      const result = applyGateAction({
        type: 'timer_expired',
        at: nowRef.current(),
      });
      if (!result.changed) return;
      emitGateEvent({
        gateEvent: 'timer_ready',
        gatePhase: result.next.phase,
        transition: readTransition(previous, result.next),
        nextEligibleAt: result.next.nextEligibleAt,
      });
    }, waitMs);

    return () => window.clearTimeout(timer);
  }, [applyGateAction, emitGateEvent, gateState]);

  useEffect(() => {
    if (!candidateKey) {
      lastCandidateKeyRef.current = null;
      lastDecisionKeyRef.current = null;
      if (
        timingModeRef.current === 'monotonic' &&
        gateState.phase === 'ready' &&
        gateState.quietStartedAt !== null &&
        gateState.readinessThreshold !== null
      ) {
        const opportunityKey = `${gateState.quietStartedAt}:${gateState.readinessThreshold}`;
        if (lastSkippedOpportunityRef.current !== opportunityKey) {
          lastSkippedOpportunityRef.current = opportunityKey;
          emitGateEvent({
            gateEvent: 'opportunity_skipped',
            gatePhase: gateState.phase,
            transition: 'blocked',
            blockedBy: 'no_candidate',
            opportunityOutcome: 'skipped',
          });
          applyGateAction({
            type: 'opportunity_skipped',
            at: nowRef.current(),
          });
        }
      }
      return;
    }

    lastSkippedOpportunityRef.current = null;

    if (lastCandidateKeyRef.current !== candidateKey) {
      lastCandidateKeyRef.current = candidateKey;
      lastDecisionKeyRef.current = null;
      emitGateEvent({
        gateEvent: 'candidate_selected',
        gatePhase: gateState.phase,
      });
    }

    const schedulerState: AutonomousSchedulerState = {
      hasCandidate,
      isBusy,
      isVoiceActivityActive,
      isLoopEnabled,
      isMuted,
      isReady,
      isVisible,
      isTurnGateReady: isAutonomyTurnGateReady(gateState),
    };
    const blockReason = readBlockReason(schedulerState, gateState);
    if (!shouldScheduleAutonomousTalk(schedulerState)) {
      const decisionKey = `${candidateKey}:${gateState.phase}:${
        gateState.nextEligibleAt ?? 'none'
      }:${blockReason ?? 'running'}`;
      if (lastDecisionKeyRef.current !== decisionKey) {
        lastDecisionKeyRef.current = decisionKey;
        emitGateEvent({
          gateEvent: 'gate_blocked',
          gatePhase: gateState.phase,
          transition: 'blocked',
          blockedBy: blockReason ?? 'running',
          nextEligibleAt: gateState.nextEligibleAt,
          delayMs:
            gateState.nextEligibleAt === null
              ? undefined
              : Math.max(0, gateState.nextEligibleAt - nowRef.current()),
        });
      }
      return;
    }
    if (dispatchedCandidateRef.current === candidateKey) return;

    const passedDecisionKey = `${candidateKey}:passed`;
    if (lastDecisionKeyRef.current !== passedDecisionKey) {
      lastDecisionKeyRef.current = passedDecisionKey;
      emitGateEvent({
        gateEvent: 'gate_passed',
        gatePhase: gateState.phase,
        transition: 'passed',
        opportunityOutcome: 'fired',
      });
    }

    dispatchedCandidateRef.current = candidateKey;
    activeCandidateTelemetryRef.current = candidateTelemetryRef.current;
    const startedAt = nowRef.current();
    const started = applyGateAction({ type: 'turn_started', at: startedAt });
    if (!started.changed) {
      activeCandidateTelemetryRef.current = null;
      return;
    }
    emitGateEvent({
      gateEvent: 'turn_started',
      gatePhase: started.next.phase,
      transition: readTransition(gateState, started.next),
    });

    void onCandidateRef
      .current()
      .then((outcome) => {
        const completed = outcome === 'speak' || outcome === 'none';
        const previous = gateStateRef.current;
        const result = applyGateAction({
          type: completed ? 'turn_completed' : 'turn_aborted',
          at: nowRef.current(),
        });
        if (!result.changed) return;
        const delayMs =
          result.next.nextEligibleAt === null
            ? undefined
            : Math.max(0, result.next.nextEligibleAt - nowRef.current());
        emitGateEvent({
          gateEvent: completed ? 'turn_completed' : 'turn_aborted',
          gatePhase: result.next.phase,
          transition: readTransition(previous, result.next),
          externalAction: completed
            ? outcome === 'speak'
              ? 'speak'
              : 'none'
            : undefined,
          nextEligibleAt: result.next.nextEligibleAt,
          delayMs,
        }, activeCandidateTelemetryRef.current);
        activeCandidateTelemetryRef.current = null;
      })
      .catch(() => {
        const previous = gateStateRef.current;
        const result = applyGateAction({
          type: 'turn_aborted',
          at: nowRef.current(),
        });
        if (!result.changed) return;
        emitGateEvent({
          gateEvent: 'turn_aborted',
          gatePhase: result.next.phase,
          transition: readTransition(previous, result.next),
          nextEligibleAt: result.next.nextEligibleAt,
        }, activeCandidateTelemetryRef.current);
        activeCandidateTelemetryRef.current = null;
      });
  }, [
    applyGateAction,
    candidateKey,
    emitGateEvent,
    gateState,
    hasCandidate,
    isBusy,
    isLoopEnabled,
    isMuted,
    isReady,
    isVoiceActivityActive,
    isVisible,
  ]);
}
