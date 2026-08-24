export const AUTONOMY_EVIDENCE_KINDS = [
  'conversation_input',
  'environment_change',
  'activity_change',
  'internal_state_change',
  'interaction_state_change',
] as const;

export type AutonomyEvidenceKind =
  (typeof AUTONOMY_EVIDENCE_KINDS)[number];

export const CANDIDATE_REASON_KINDS = [
  'conversation_continuation',
  'new_inference',
  'new_association',
  'environment_change',
  'unfinished_intent',
  'salience_change',
  'participant_reengagement',
  'self_interest',
] as const;

export type CandidateReasonKind = (typeof CANDIDATE_REASON_KINDS)[number];

export const CANDIDATE_REASON_STATUSES = [
  'active',
  'resolved',
  'expired',
  'merged',
  'deferred',
] as const;

export type CandidateReasonStatus =
  (typeof CANDIDATE_REASON_STATUSES)[number];

export const AUTONOMY_WAKE_CONDITIONS = [
  'floor_available',
  'attention_available',
  'topic_reactivated',
  'new_evidence',
  'higher_priority_resolved',
  'interaction_state_changed',
] as const;

export type AutonomyWakeCondition =
  (typeof AUTONOMY_WAKE_CONDITIONS)[number];

export const AUTONOMY_DEFER_CAUSES = [
  'floor_unavailable',
  'attention_unavailable',
  'topic_mismatch',
  'weak_evidence',
  'higher_priority',
  'interaction_unavailable',
] as const;

export type AutonomyDeferCause = (typeof AUTONOMY_DEFER_CAUSES)[number];

export const AUTONOMY_EXTERNAL_ACTIONS = ['speak', 'none'] as const;
export type AutonomyExternalAction =
  (typeof AUTONOMY_EXTERNAL_ACTIONS)[number];

export interface AutonomyReasonProposal {
  kind: CandidateReasonKind;
  content: string;
  semanticKey: string;
  salience: number;
  parentReasonId?: string | null;
}

export interface AutonomyEvidence {
  id: string;
  kind: AutonomyEvidenceKind;
  at: number;
  semanticKey: string;
  content?: string;
  wakeConditions?: readonly AutonomyWakeCondition[];
  reasonProposals?: readonly AutonomyReasonProposal[];
  episodeId?: string | null;
  parentEpisodeId?: string | null;
  parentReasonId?: string | null;
}

export interface CandidateReason {
  id: string;
  episodeId: string;
  parentReasonId: string | null;
  kind: CandidateReasonKind;
  content: string;
  semanticKey: string;
  salience: number;
  status: CandidateReasonStatus;
  deferCause: AutonomyDeferCause | null;
  wakeOn: readonly AutonomyWakeCondition[];
  evidenceIds: readonly string[];
  createdAt: number;
  updatedAt: number;
  lastEvaluatedEvidenceId: string | null;
  mergedIntoReasonId: string | null;
}

export interface AutonomyEpisode {
  id: string;
  rootEvidenceId: string;
  parentEpisodeId: string | null;
  depth: number;
  status: 'active' | 'completed' | 'safety_stopped';
  lastEvidenceId: string;
  createdAt: number;
  updatedAt: number;
}

export type ReasonUpdate =
  | {
      operation: 'create';
      kind: CandidateReasonKind;
      content: string;
      semanticKey: string;
      salience: number;
      parentReasonId?: string | null;
    }
  | {
      operation: 'reinforce';
      reasonId: string;
      content?: string;
      salienceDelta?: number;
    }
  | {
      operation: 'resolve' | 'expire';
      reasonId: string;
    }
  | {
      operation: 'defer';
      reasonId: string;
      cause: AutonomyDeferCause;
      wakeOn: readonly AutonomyWakeCondition[];
    }
  | {
      operation: 'reactivate';
      reasonId: string;
      salienceDelta?: number;
    }
  | {
      operation: 'merge';
      reasonId: string;
      targetReasonId: string;
    };

export interface AutonomyInternalDelta {
  reasonUpdates: readonly ReasonUpdate[];
}

export interface AutonomyState {
  reasons: readonly CandidateReason[];
  episodes: readonly AutonomyEpisode[];
  processedEvidenceIds: readonly string[];
  version: number;
}

export interface AutonomyReasonUpdateResult {
  state: AutonomyState;
  changed: boolean;
  createdReasonIds: readonly string[];
  rejectedUpdates: readonly string[];
}

export interface AutonomyCandidate {
  episodeId: string;
  reasons: readonly CandidateReason[];
  evidenceIds: readonly string[];
}

export interface AutonomyReadiness {
  enabled: boolean;
  busy: boolean;
  floorAvailable: boolean;
  attentionAvailable: boolean;
  interactionAvailable: boolean;
}

export const MAX_AUTONOMY_CONTENT_LENGTH = 120;
export const MAX_ACTIVE_REASONS = 24;
export const MAX_EPISODE_DEPTH = 8;
export const MAX_REASON_UPDATES_PER_DELTA = 8;
export const MAX_CANDIDATE_REASONS = 4;

const TERMINAL_REASON_STATUSES = new Set<CandidateReasonStatus>([
  'resolved',
  'expired',
  'merged',
]);

let autonomySequence = 0;

function createId(prefix: string): string {
  autonomySequence += 1;
  return `${prefix}-${Date.now()}-${autonomySequence}`;
}

function normalizeText(value: string, maximum = MAX_AUTONOMY_CONTENT_LENGTH): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizeSalience(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function normalizeWakeConditions(
  conditions: readonly AutonomyWakeCondition[] | undefined,
): readonly AutonomyWakeCondition[] {
  return [...new Set(conditions ?? [])];
}

export function isAutonomyExternalAction(
  value: unknown,
): value is AutonomyExternalAction {
  return (
    typeof value === 'string' &&
    (AUTONOMY_EXTERNAL_ACTIONS as readonly string[]).includes(value)
  );
}

export function isCandidateReasonKind(
  value: unknown,
): value is CandidateReasonKind {
  return (
    typeof value === 'string' &&
    (CANDIDATE_REASON_KINDS as readonly string[]).includes(value)
  );
}

export function isAutonomyWakeCondition(
  value: unknown,
): value is AutonomyWakeCondition {
  return (
    typeof value === 'string' &&
    (AUTONOMY_WAKE_CONDITIONS as readonly string[]).includes(value)
  );
}

export function isAutonomyDeferCause(
  value: unknown,
): value is AutonomyDeferCause {
  return (
    typeof value === 'string' &&
    (AUTONOMY_DEFER_CAUSES as readonly string[]).includes(value)
  );
}

function replaceReason(
  reasons: readonly CandidateReason[],
  nextReason: CandidateReason,
): readonly CandidateReason[] {
  return reasons.map((reason) =>
    reason.id === nextReason.id ? nextReason : reason,
  );
}

function findReason(
  state: AutonomyState,
  reasonId: string,
): CandidateReason | null {
  return state.reasons.find((reason) => reason.id === reasonId) ?? null;
}

function latestEvidenceId(reason: CandidateReason): string | null {
  return reason.evidenceIds[reason.evidenceIds.length - 1] ?? null;
}

function countActiveReasons(reasons: readonly CandidateReason[]): number {
  return reasons.filter((reason) => reason.status === 'active').length;
}

function addEpisode(
  state: AutonomyState,
  evidence: AutonomyEvidence,
  now: number,
): { state: AutonomyState; episode: AutonomyEpisode } {
  const parentEpisode = evidence.parentReasonId
    ? state.reasons.find((reason) => reason.id === evidence.parentReasonId)
    : undefined;
  const parentEpisodeId =
    evidence.parentEpisodeId ?? parentEpisode?.episodeId ?? null;
  const parent = parentEpisodeId
    ? state.episodes.find((episode) => episode.id === parentEpisodeId)
    : undefined;
  const depth = parent ? parent.depth + 1 : 0;
  const episode: AutonomyEpisode = {
    id: evidence.episodeId ?? createId('episode'),
    rootEvidenceId: parent?.rootEvidenceId ?? evidence.id,
    parentEpisodeId,
    depth,
    status: depth > MAX_EPISODE_DEPTH ? 'safety_stopped' : 'active',
    lastEvidenceId: evidence.id,
    createdAt: now,
    updatedAt: now,
  };
  return {
    state: {
      ...state,
      episodes: [...state.episodes, episode],
    },
    episode,
  };
}

function findOpenReasonBySemanticKey(
  state: AutonomyState,
  episodeId: string,
  semanticKey: string,
): CandidateReason | null {
  const normalizedSemanticKey = normalizeText(semanticKey);
  return (
    state.reasons.find(
      (reason) =>
        reason.episodeId === episodeId &&
        reason.semanticKey === normalizedSemanticKey &&
        (reason.status === 'active' || reason.status === 'deferred'),
    ) ?? null
  );
}

function addReasonFromProposal(
  state: AutonomyState,
  proposal: AutonomyReasonProposal,
  evidence: AutonomyEvidence,
  episode: AutonomyEpisode,
  now: number,
): { state: AutonomyState; reason: CandidateReason | null; changed: boolean } {
  const content = normalizeText(proposal.content);
  const semanticKey = normalizeText(proposal.semanticKey);
  const parentReasonId = proposal.parentReasonId ?? evidence.parentReasonId ?? null;
  if (!content || !semanticKey || episode.status !== 'active') {
    return { state, reason: null, changed: false };
  }
  if (parentReasonId) {
    const parent = findReason(state, parentReasonId);
    if (
      !parent ||
      parent.episodeId !== episode.id ||
      TERMINAL_REASON_STATUSES.has(parent.status)
    ) {
      return { state, reason: null, changed: false };
    }
  }

  const existing = findOpenReasonBySemanticKey(state, episode.id, semanticKey);
  if (existing) {
    const deferredWakeMatched =
      existing.status !== 'deferred' ||
      evidence.wakeConditions?.some((condition) =>
        existing.wakeOn.includes(condition),
      ) === true;
    if (!deferredWakeMatched) {
      return { state, reason: existing, changed: false };
    }
    const salience = normalizeSalience(proposal.salience);
    const nextReason: CandidateReason = {
      ...existing,
      content,
      salience,
      status: existing.status === 'deferred' ? 'active' : existing.status,
      deferCause: null,
      wakeOn: [],
      evidenceIds: [...new Set([...existing.evidenceIds, evidence.id])],
      updatedAt: now,
    };
    return {
      state: replaceStateReason(state, nextReason),
      reason: nextReason,
      changed:
        existing.status !== nextReason.status ||
        existing.content !== nextReason.content ||
        existing.salience !== nextReason.salience ||
        existing.evidenceIds.length !== nextReason.evidenceIds.length,
    };
  }

  if (countActiveReasons(state.reasons) >= MAX_ACTIVE_REASONS) {
    return { state, reason: null, changed: false };
  }

  const reason: CandidateReason = {
    id: createId('reason'),
    episodeId: episode.id,
    parentReasonId,
    kind: proposal.kind,
    content,
    semanticKey,
    salience: normalizeSalience(proposal.salience),
    status: 'active',
    deferCause: null,
    wakeOn: [],
    evidenceIds: [evidence.id],
    createdAt: now,
    updatedAt: now,
    lastEvaluatedEvidenceId: null,
    mergedIntoReasonId: null,
  };
  return {
    state: {
      ...state,
      reasons: [...state.reasons, reason],
    },
    reason,
    changed: true,
  };
}

function replaceStateReason(
  state: AutonomyState,
  reason: CandidateReason,
): AutonomyState {
  return {
    ...state,
    reasons: replaceReason(state.reasons, reason),
    version: state.version + 1,
  };
}

function markEvidenceProcessed(
  state: AutonomyState,
  evidenceId: string,
): AutonomyState {
  if (state.processedEvidenceIds.includes(evidenceId)) return state;
  return {
    ...state,
    processedEvidenceIds: [...state.processedEvidenceIds, evidenceId].slice(-128),
    version: state.version + 1,
  };
}

export function createInitialAutonomyState(): AutonomyState {
  return {
    reasons: [],
    episodes: [],
    processedEvidenceIds: [],
    version: 0,
  };
}

export function observeAutonomyEvidence(
  current: AutonomyState,
  evidence: AutonomyEvidence,
): AutonomyState {
  if (current.processedEvidenceIds.includes(evidence.id)) return current;

  const now = Number.isFinite(evidence.at) ? evidence.at : Date.now();
  let state = markEvidenceProcessed(current, evidence.id);
  for (const reason of state.reasons) {
    if (
      reason.status === 'deferred' &&
      evidence.wakeConditions?.some((condition) => reason.wakeOn.includes(condition))
    ) {
      state = replaceStateReason(state, {
        ...reason,
        status: 'active',
        deferCause: null,
        wakeOn: [],
        evidenceIds: [...new Set([...reason.evidenceIds, evidence.id])],
        updatedAt: now,
      });
    }
  }
  let episode = evidence.episodeId
    ? state.episodes.find((item) => item.id === evidence.episodeId) ?? null
    : null;

  const hasReasonProposals = (evidence.reasonProposals?.length ?? 0) > 0;
  if (!episode && !hasReasonProposals) {
    return state;
  }

  if (!episode) {
    const created = addEpisode(state, evidence, now);
    state = created.state;
    episode = created.episode;
  } else {
    const nextEpisode: AutonomyEpisode = {
      ...episode,
      lastEvidenceId: evidence.id,
      updatedAt: now,
    };
    state = {
      ...state,
      episodes: state.episodes.map((item) =>
        item.id === nextEpisode.id ? nextEpisode : item,
      ),
      version: state.version + 1,
    };
  }

  if (episode.status !== 'active') return state;

  for (const proposal of evidence.reasonProposals ?? []) {
    state = addReasonFromProposal(state, proposal, evidence, episode, now).state;
  }

  return state;
}

export function markCandidateOffered(
  current: AutonomyState,
  candidate: AutonomyCandidate,
): AutonomyState {
  const evidenceByReason = new Map<string, string>();
  for (const reason of candidate.reasons) {
    const evidenceId = latestEvidenceId(reason);
    if (evidenceId) evidenceByReason.set(reason.id, evidenceId);
  }
  let changed = false;
  const reasons = current.reasons.map((reason) => {
    const evidenceId = evidenceByReason.get(reason.id);
    if (!evidenceId || reason.lastEvaluatedEvidenceId === evidenceId) {
      return reason;
    }
    changed = true;
    return { ...reason, lastEvaluatedEvidenceId: evidenceId };
  });
  return changed
    ? { ...current, reasons, version: current.version + 1 }
    : current;
}

export function selectAutonomyCandidate(
  current: AutonomyState,
  readiness: AutonomyReadiness,
): AutonomyCandidate | null {
  if (
    !readiness.enabled ||
    readiness.busy ||
    !readiness.floorAvailable ||
    !readiness.attentionAvailable ||
    !readiness.interactionAvailable
  ) {
    return null;
  }

  const activeEpisodeIds = new Set(
    current.episodes
      .filter((episode) => episode.status === 'active')
      .map((episode) => episode.id),
  );
  const eligible = current.reasons
    .filter(
      (reason) =>
        reason.status === 'active' &&
        activeEpisodeIds.has(reason.episodeId) &&
        latestEvidenceId(reason) !== reason.lastEvaluatedEvidenceId,
    )
    .sort((left, right) => right.salience - left.salience)
    .slice(0, MAX_CANDIDATE_REASONS);
  if (!eligible.length) return null;

  const episodeId = eligible[0].episodeId;
  const reasons = eligible.filter((reason) => reason.episodeId === episodeId);
  return {
    episodeId,
    reasons,
    evidenceIds: [...new Set(reasons.flatMap((reason) => reason.evidenceIds))],
  };
}

export function deferReasons(
  current: AutonomyState,
  reasonIds: readonly string[],
  cause: AutonomyDeferCause,
  wakeOn: readonly AutonomyWakeCondition[],
  at = Date.now(),
): AutonomyState {
  const ids = new Set(reasonIds);
  const normalizedWakeOn = normalizeWakeConditions(wakeOn);
  let changed = false;
  const reasons = current.reasons.map((reason) => {
    if (!ids.has(reason.id) || reason.status !== 'active') return reason;
    changed = true;
    return {
      ...reason,
      status: 'deferred' as const,
      deferCause: cause,
      wakeOn: normalizedWakeOn,
      updatedAt: at,
    };
  });
  return changed
    ? { ...current, reasons, version: current.version + 1 }
    : current;
}

export function applyReasonUpdates(
  current: AutonomyState,
  updates: readonly ReasonUpdate[],
  context: {
    episodeId: string;
    evidenceId: string;
    at?: number;
  },
): AutonomyReasonUpdateResult {
  const at = context.at ?? Date.now();
  let state = current;
  let changed = false;
  const createdReasonIds: string[] = [];
  const rejectedUpdates: string[] = [];
  const limitedUpdates = updates.slice(0, MAX_REASON_UPDATES_PER_DELTA);
  if (updates.length > MAX_REASON_UPDATES_PER_DELTA) {
    rejectedUpdates.push('delta:too-many-updates');
  }

  for (const update of limitedUpdates) {
    if (update.operation === 'create') {
      const proposal: AutonomyReasonProposal = {
        kind: update.kind,
        content: update.content,
        semanticKey: update.semanticKey,
        salience: update.salience,
        parentReasonId: update.parentReasonId,
      };
      const episode = state.episodes.find((item) => item.id === context.episodeId);
      if (!episode) {
        rejectedUpdates.push('create:unknown-episode');
        continue;
      }
      if (proposal.parentReasonId) {
        const parent = findReason(state, proposal.parentReasonId);
        if (
          !parent ||
          parent.episodeId !== context.episodeId ||
          TERMINAL_REASON_STATUSES.has(parent.status)
        ) {
          rejectedUpdates.push('create:invalid-parent');
          continue;
        }
      }
      const reasonBeforeUpdate = findOpenReasonBySemanticKey(
        state,
        context.episodeId,
        proposal.semanticKey,
      );
      const result = addReasonFromProposal(
        state,
        proposal,
        {
          id: context.evidenceId,
          kind: 'internal_state_change',
          at,
          semanticKey: update.semanticKey,
          reasonProposals: [proposal],
          episodeId: context.episodeId,
          parentReasonId: update.parentReasonId,
        },
        episode,
        at,
      );
      state = result.state;
      changed ||= result.changed;
      if (
        result.reason &&
        !reasonBeforeUpdate &&
        state.reasons.some((reason) => reason.id === result.reason?.id)
      ) {
        createdReasonIds.push(result.reason.id);
      }
      continue;
    }

    const reason = findReason(state, update.reasonId);
    if (!reason || reason.episodeId !== context.episodeId) {
      rejectedUpdates.push(`${update.operation}:unknown-reason`);
      continue;
    }

    if (update.operation === 'reinforce') {
      if (TERMINAL_REASON_STATUSES.has(reason.status)) {
        rejectedUpdates.push('reinforce:terminal-reason');
        continue;
      }
      const nextReason: CandidateReason = {
        ...reason,
        content: update.content
          ? normalizeText(update.content)
          : reason.content,
        salience: normalizeSalience(
          reason.salience + (update.salienceDelta ?? 0),
        ),
        status: 'active',
        deferCause: null,
        wakeOn: [],
        evidenceIds: [...new Set([...reason.evidenceIds, context.evidenceId])],
        updatedAt: at,
      };
      state = replaceStateReason(state, nextReason);
      changed ||=
        nextReason.content !== reason.content ||
        nextReason.salience !== reason.salience ||
        nextReason.status !== reason.status ||
        nextReason.deferCause !== reason.deferCause ||
        nextReason.wakeOn.length !== reason.wakeOn.length ||
        nextReason.evidenceIds.length !== reason.evidenceIds.length;
      continue;
    }

    if (update.operation === 'reactivate') {
      if (!['deferred', 'expired'].includes(reason.status)) {
        rejectedUpdates.push('reactivate:invalid-status');
        continue;
      }
      state = replaceStateReason(state, {
        ...reason,
        status: 'active',
        salience: normalizeSalience(
          reason.salience + (update.salienceDelta ?? 0),
        ),
        deferCause: null,
        wakeOn: [],
        evidenceIds: [...new Set([...reason.evidenceIds, context.evidenceId])],
        updatedAt: at,
      });
      changed = true;
      continue;
    }

    if (update.operation === 'defer') {
      if (TERMINAL_REASON_STATUSES.has(reason.status)) {
        rejectedUpdates.push('defer:terminal-reason');
        continue;
      }
      state = replaceStateReason(state, {
        ...reason,
        status: 'deferred',
        deferCause: update.cause,
        wakeOn: normalizeWakeConditions(update.wakeOn),
        updatedAt: at,
      });
      changed ||=
        reason.status !== 'deferred' ||
        reason.deferCause !== update.cause ||
        reason.wakeOn.length !== update.wakeOn.length ||
        update.wakeOn.some((condition) => !reason.wakeOn.includes(condition));
      continue;
    }

    if (update.operation === 'resolve' || update.operation === 'expire') {
      if (TERMINAL_REASON_STATUSES.has(reason.status)) {
        rejectedUpdates.push(`${update.operation}:terminal-reason`);
        continue;
      }
      state = replaceStateReason(state, {
        ...reason,
        status: update.operation === 'resolve' ? 'resolved' : 'expired',
        deferCause: null,
        wakeOn: [],
        updatedAt: at,
      });
      changed ||= reason.status !== (update.operation === 'resolve' ? 'resolved' : 'expired');
      continue;
    }

    if (update.operation === 'merge') {
      const target = findReason(state, update.targetReasonId);
      if (
        !target ||
        target.episodeId !== context.episodeId ||
        target.id === reason.id
      ) {
        rejectedUpdates.push('merge:invalid-target');
        continue;
      }
      state = replaceStateReason(state, {
        ...reason,
        status: 'merged',
        deferCause: null,
        wakeOn: [],
        mergedIntoReasonId: update.targetReasonId,
        updatedAt: at,
      });
      changed ||= reason.status !== 'merged' ||
        reason.mergedIntoReasonId !== update.targetReasonId;
    }
  }

  return { state, changed, createdReasonIds, rejectedUpdates };
}

export function resolveUsedReasons(
  current: AutonomyState,
  reasonIds: readonly string[],
  episodeId: string,
  at = Date.now(),
): AutonomyState {
  const ids = new Set(reasonIds);
  let changed = false;
  const reasons = current.reasons.map((reason) => {
    if (
      !ids.has(reason.id) ||
      reason.episodeId !== episodeId ||
      TERMINAL_REASON_STATUSES.has(reason.status)
    ) {
      return reason;
    }
    changed = true;
    return {
      ...reason,
      status: 'resolved' as const,
      deferCause: null,
      wakeOn: [],
      updatedAt: at,
    };
  });
  return changed
    ? { ...current, reasons, version: current.version + 1 }
    : current;
}

export function completeInactiveEpisodes(
  current: AutonomyState,
  at = Date.now(),
): AutonomyState {
  const activeEpisodeIds = new Set(
    current.reasons
      .filter((reason) => reason.status === 'active' || reason.status === 'deferred')
      .map((reason) => reason.episodeId),
  );
  let changed = false;
  const episodes = current.episodes.map((episode) => {
    if (episode.status !== 'active' || activeEpisodeIds.has(episode.id)) {
      return episode;
    }
    changed = true;
    return { ...episode, status: 'completed' as const, updatedAt: at };
  });
  return changed
    ? { ...current, episodes, version: current.version + 1 }
    : current;
}
