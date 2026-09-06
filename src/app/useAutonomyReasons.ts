import {
  useCallback,
  useRef,
  useState
} from 'react';
import {
  applyReasonUpdates,
  completeInactiveEpisodes,
  createAutonomyEvidenceId,
  createInitialAutonomyState,
  observeAutonomyEvidence,
  resolveUsedReasons,
  type AutonomyEvidence,
  type AutonomyInternalDelta,
  type AutonomyState
} from '../conversation/autonomyState';
import {
  type AutonomyTurnGateExternalEvent
} from '../conversation/autonomyTurnGate';
import { emitAutonomyGateEvent } from '../conversation/conversationEvents';
import {
  type AutonomyExternalEventSignal
} from '../conversation/useAutonomousTalk';
import {
  type AutonomyDeltaContext,
  type AutonomyEvidenceContext
} from '../conversation/useConversation';

export function useAutonomyReasons() {
  const [autonomyState, setAutonomyState] = useState<AutonomyState>(
    createInitialAutonomyState,
  );
  const [autonomyExternalEvent, setAutonomyExternalEvent] = useState<
    AutonomyExternalEventSignal | null
  >(null);
  const autonomyStateRef = useRef(autonomyState);
  const recordAutonomyEvidence = useCallback((evidence: AutonomyEvidence) => {
    const nextState = observeAutonomyEvidence(autonomyStateRef.current, evidence);
    autonomyStateRef.current = nextState;
    setAutonomyState(nextState);
    return nextState;
  }, []);
  const notifyMeaningfulAutonomyEvent = useCallback(
    (kind: AutonomyTurnGateExternalEvent) => {
      setAutonomyExternalEvent((current) => ({
        sequence: (current?.sequence ?? 0) + 1,
        kind,
      }));
    },
    [],
  );
  const readAutonomyEvidenceContext = useCallback(
    (state: AutonomyState, evidenceId: string): AutonomyEvidenceContext | null => {
      const matchingReasons = state.reasons.filter(
        (reason) =>
          reason.status === 'active' &&
          reason.decisionEvidenceIds.includes(evidenceId),
      );
      const episodeId = matchingReasons[0]?.episodeId;
      if (!episodeId) return null;
      return {
        episodeId,
        evidenceId,
        reasonIds: matchingReasons
          .filter((reason) => reason.episodeId === episodeId)
          .map((reason) => reason.id),
      };
    },
    [],
  );
  const handleAutonomyDelta = useCallback(
    (
      delta: AutonomyInternalDelta,
      context: AutonomyDeltaContext,
    ) => {
      const current = autonomyStateRef.current;
      const episodeId =
        context.episodeId ??
        current.reasons.find((reason) =>
          reason.decisionEvidenceIds.includes(context.evidenceId),
        )?.episodeId ??
        null;
      if (!episodeId) return;
      let nextState = current;
      let createdReasonIds: readonly string[] = [];
      let resolvedReasonIds: readonly string[] = [];
      const internalDeltaOperations = delta.reasonUpdates.map(
        (update) => update.operation,
      );
      if (delta.reasonUpdates.length) {
        const deltaEvidenceId = createAutonomyEvidenceId('autonomy-delta');
        const stateWithDeltaEvidence = observeAutonomyEvidence(current, {
          id: deltaEvidenceId,
          kind: 'internal_state_change',
          at: Date.now(),
          semanticKey: `internal-delta:${context.source}`,
          episodeId,
        });
        const result = applyReasonUpdates(stateWithDeltaEvidence, delta.reasonUpdates, {
          episodeId,
          evidenceId: deltaEvidenceId,
          at: Date.now(),
        });
        createdReasonIds = result.createdReasonIds;
        resolvedReasonIds = result.state.reasons
          .filter((reason) => {
            if (reason.status !== 'resolved') return false;
            const previous = current.reasons.find(
              (candidate) => candidate.id === reason.id,
            );
            return previous?.status !== 'resolved';
          })
          .map((reason) => reason.id);
        if (result.changed) nextState = result.state;
      }
      const resolvableReasonIds = context.reasonIds.filter((reasonId) =>
        nextState.reasons.some(
          (reason) => reason.id === reasonId && reason.status === 'active',
        ),
      );
      if (context.resolvesReason && resolvableReasonIds.length) {
        resolvedReasonIds = [
          ...new Set([...resolvedReasonIds, ...resolvableReasonIds]),
        ];
        nextState = resolveUsedReasons(
          nextState,
          resolvableReasonIds,
          episodeId,
        );
      }
      nextState = completeInactiveEpisodes(nextState);
      if (delta.reasonUpdates.length || resolvedReasonIds.length) {
        emitAutonomyGateEvent({
          gateEvent: 'internal_delta',
          gatePhase: 'running',
          transition: 'ignored',
          internalDeltaOperations,
          affectedReasonIds: [
            ...new Set([
              ...context.reasonIds,
              ...createdReasonIds,
              ...resolvedReasonIds,
            ]),
          ],
          createdReasonIds,
          resolvedReasonIds,
        });
      }
      if (nextState === current) return;
      autonomyStateRef.current = nextState;
      setAutonomyState(nextState);
    },
    [],
  );
  return { autonomyState, setAutonomyState, autonomyExternalEvent, setAutonomyExternalEvent, autonomyStateRef, recordAutonomyEvidence, notifyMeaningfulAutonomyEvent, readAutonomyEvidenceContext, handleAutonomyDelta };
}
