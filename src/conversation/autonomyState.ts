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
  decisionEvidenceIds: readonly string[];
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
  evidenceHistory: readonly AutonomyEvidence[];
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
  decisionEvidenceIds: readonly string[];
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
export const MAX_DECISION_EVIDENCE_IDS = 24;

export const DECISION_EVIDENCE_KIND_LIMITS: Readonly<
  Record<AutonomyEvidenceKind, number>
> = {
  conversation_input: 6,
  environment_change: 4,
  activity_change: 3,
  internal_state_change: 4,
  interaction_state_change: 4,
};

export const ENVIRONMENT_EVIDENCE_MAX_AGE_MS = 8_000;

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

export function createAutonomyEvidenceId(prefix: string): string {
  return createId(normalizeText(prefix, 32).replace(/[^a-zA-Z0-9_-]/gu, '-') || 'evidence');
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

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  return reason.decisionEvidenceIds[reason.decisionEvidenceIds.length - 1] ?? null;
}

function latestEvidenceByKind(
  state: AutonomyState,
  kind: AutonomyEvidenceKind,
  now: number,
): AutonomyEvidence | null {
  let latest: AutonomyEvidence | null = null;
  for (const evidence of state.evidenceHistory) {
    if (evidence.kind !== kind || evidence.at > now) continue;
    if (!latest || evidence.at >= latest.at) latest = evidence;
  }
  return latest;
}

function reasonCausalAnchorIds(
  state: AutonomyState,
  reason: CandidateReason,
): ReadonlySet<string> {
  const anchorIds = new Set<string>();
  const currentReasonAnchor = reason.decisionEvidenceIds[0];
  if (currentReasonAnchor) anchorIds.add(currentReasonAnchor);
  let parentReasonId = reason.parentReasonId;
  const visited = new Set<string>();
  while (parentReasonId && !visited.has(parentReasonId)) {
    visited.add(parentReasonId);
    const parent = findReason(state, parentReasonId);
    if (!parent || parent.episodeId !== reason.episodeId) break;
    const parentAnchor = parent.decisionEvidenceIds[0];
    if (parentAnchor) anchorIds.add(parentAnchor);
    parentReasonId = parent.parentReasonId;
  }
  const episode = state.episodes.find((item) => item.id === reason.episodeId);
  if (episode) anchorIds.add(episode.rootEvidenceId);
  return anchorIds;
}

function selectIncrementalConversationEvidence(
  state: AutonomyState,
  reason: CandidateReason,
  triggerEvidenceIds: readonly string[],
): readonly string[] | null {
  if (reason.kind !== 'conversation_continuation' || triggerEvidenceIds.length !== 1) {
    return null;
  }
  const triggerEvidenceId = triggerEvidenceIds[0];
  const triggerEvidence = state.evidenceHistory[state.evidenceHistory.length - 1];
  if (
    !triggerEvidence ||
    triggerEvidence.id !== triggerEvidenceId ||
    triggerEvidence.kind !== 'conversation_input' ||
    triggerEvidence.episodeId !== reason.episodeId
  ) {
    return null;
  }

  const orderedIds = [...new Set([
    ...reason.decisionEvidenceIds,
    triggerEvidenceId,
  ])];
  const anchorIds = reasonCausalAnchorIds(state, reason);
  const anchors = orderedIds.filter((evidenceId) => anchorIds.has(evidenceId));
  const recentNonAnchors = [...orderedIds]
    .reverse()
    .filter((evidenceId) => !anchorIds.has(evidenceId));
  const selectedIds = [
    ...anchors.slice(0, DECISION_EVIDENCE_KIND_LIMITS.conversation_input),
    ...recentNonAnchors.slice(
      0,
      Math.max(
        0,
        DECISION_EVIDENCE_KIND_LIMITS.conversation_input - anchors.length,
      ),
    ),
  ];
  const selected = new Set(selectedIds);
  return orderedIds.filter((evidenceId) => selected.has(evidenceId));
}

function evidenceMatchesReason(
  evidence: AutonomyEvidence,
  reason: CandidateReason,
): boolean {
  const proposalMatches = evidence.reasonProposals?.some(
    (proposal) =>
      normalizeText(proposal.semanticKey) === reason.semanticKey ||
      proposal.parentReasonId === reason.id ||
      proposal.parentReasonId === reason.parentReasonId ||
      proposal.kind === reason.kind,
  );
  return (
    normalizeText(evidence.semanticKey) === reason.semanticKey ||
    evidence.parentReasonId === reason.id ||
    evidence.parentReasonId === reason.parentReasonId ||
    proposalMatches === true ||
    (reason.kind === 'conversation_continuation' &&
      evidence.kind === 'conversation_input') ||
    (reason.kind === 'environment_change' &&
      evidence.kind === 'environment_change')
  );
}

function evidenceIsRetained(
  state: AutonomyState,
  evidence: AutonomyEvidence,
  reason: CandidateReason,
  now: number,
): boolean {
  switch (evidence.kind) {
    case 'conversation_input':
      return evidence.episodeId === reason.episodeId;
    case 'environment_change': {
      const age = now - evidence.at;
      return age >= 0 && age <= ENVIRONMENT_EVIDENCE_MAX_AGE_MS;
    }
    case 'activity_change':
      return latestEvidenceByKind(state, evidence.kind, now)?.id === evidence.id;
    case 'internal_state_change':
      return latestEvidenceByKind(state, evidence.kind, now)?.id === evidence.id;
    case 'interaction_state_change':
      return latestEvidenceByKind(state, evidence.kind, now)?.id === evidence.id;
  }
}

interface RankedDecisionEvidence {
  evidence: AutonomyEvidence;
  causalImportance: number;
  semanticRelevance: number;
  salience: number;
  historyIndex: number;
}

function rankDecisionEvidence(
  state: AutonomyState,
  reason: CandidateReason,
  triggerEvidenceIds: ReadonlySet<string>,
  anchorIds: ReadonlySet<string>,
  evidence: AutonomyEvidence,
  historyIndex: number,
): RankedDecisionEvidence {
  const causalImportance = triggerEvidenceIds.has(evidence.id)
    ? 5
    : anchorIds.has(evidence.id)
      ? 4
      : evidence.id === state.episodes.find((item) => item.id === reason.episodeId)?.rootEvidenceId
        ? 4
        : evidence.parentReasonId === reason.id
          ? 3
          : 1;
  const semanticRelevance =
    normalizeText(evidence.semanticKey) === reason.semanticKey
      ? 3
      : evidenceMatchesReason(evidence, reason)
        ? 2
        : 1;
  const proposalSalience = Math.max(
    0,
    ...(evidence.reasonProposals ?? [])
      .filter(
        (proposal) =>
          normalizeText(proposal.semanticKey) === reason.semanticKey ||
          proposal.parentReasonId === reason.id,
      )
      .map((proposal) => normalizeSalience(proposal.salience)),
  );
  return {
    evidence,
    causalImportance,
    semanticRelevance,
    salience: Math.max(proposalSalience, reason.salience),
    historyIndex,
  };
}

function compareRankedEvidence(
  left: RankedDecisionEvidence,
  right: RankedDecisionEvidence,
): number {
  return (
    right.causalImportance - left.causalImportance ||
    right.semanticRelevance - left.semanticRelevance ||
    right.salience - left.salience ||
    right.evidence.at - left.evidence.at ||
    right.historyIndex - left.historyIndex
  );
}

function selectDecisionEvidenceForReason(
  state: AutonomyState,
  reason: CandidateReason,
  triggerEvidenceIds: readonly string[] = [],
  now = Date.now(),
): readonly string[] {
  const latestEvidence = state.evidenceHistory[state.evidenceHistory.length - 1];
  const effectiveTriggerEvidenceIds =
    triggerEvidenceIds.length === 0 &&
    latestEvidence?.kind === 'conversation_input' &&
    latestEvidence.episodeId === reason.episodeId
      ? [latestEvidence.id]
      : triggerEvidenceIds;
  const incrementalConversationEvidence = selectIncrementalConversationEvidence(
    state,
    reason,
    effectiveTriggerEvidenceIds,
  );
  if (incrementalConversationEvidence) return incrementalConversationEvidence;

  const triggerIds = new Set(effectiveTriggerEvidenceIds);
  const anchorIds = reasonCausalAnchorIds(state, reason);
  const candidateEvidenceIds = new Map<
    AutonomyEvidenceKind,
    RankedDecisionEvidence[]
  >();

  for (let historyIndex = 0; historyIndex < state.evidenceHistory.length; historyIndex += 1) {
    const evidence = state.evidenceHistory[historyIndex];
    const isExplicitTrigger = triggerIds.has(evidence.id);
    const isAnchor = anchorIds.has(evidence.id);
    const sameEpisode = evidence.episodeId === reason.episodeId;
    const contextOnly = evidence.episodeId == null && (isExplicitTrigger || isAnchor);
    if (!sameEpisode && !contextOnly) continue;
    if (!isExplicitTrigger && !isAnchor && !evidenceMatchesReason(evidence, reason)) {
      continue;
    }
    if (!evidenceIsRetained(state, evidence, reason, now)) continue;
    const rankedEvidence = rankDecisionEvidence(
      state,
      reason,
      triggerIds,
      anchorIds,
      evidence,
      historyIndex,
    );
    const rankedForKind = candidateEvidenceIds.get(evidence.kind) ?? [];
    rankedForKind.push(rankedEvidence);
    rankedForKind.sort(compareRankedEvidence);
    if (rankedForKind.length > DECISION_EVIDENCE_KIND_LIMITS[evidence.kind]) {
      rankedForKind.pop();
    }
    candidateEvidenceIds.set(evidence.kind, rankedForKind);
  }
  const selected = [...candidateEvidenceIds.values()]
    .flat()
    .sort(compareRankedEvidence);
  selected.sort(
    (left, right) => left.evidence.at - right.evidence.at || left.historyIndex - right.historyIndex,
  );
  return selected
    .slice(0, MAX_DECISION_EVIDENCE_IDS)
    .map((rankedEvidence) => rankedEvidence.evidence.id);
}

function selectDecisionEvidenceSets(
  state: AutonomyState,
  reasons: readonly CandidateReason[],
  now = Date.now(),
): ReadonlyMap<string, readonly string[]> {
  const reasonSelections = new Map<string, readonly string[]>();
  if (reasons.length === 1) {
    reasonSelections.set(
      reasons[0].id,
      selectDecisionEvidenceForReason(state, reasons[0], [], now),
    );
    return reasonSelections;
  }
  const rankedByEvidenceId = new Map<string, RankedDecisionEvidence>();
  const evidenceById = new Map(
    state.evidenceHistory.map((evidence) => [evidence.id, evidence]),
  );
  const historyIndexById = new Map(
    state.evidenceHistory.map((evidence, index) => [evidence.id, index]),
  );
  for (const reason of reasons) {
    const decisionEvidenceIds = selectDecisionEvidenceForReason(state, reason, [], now);
    reasonSelections.set(reason.id, decisionEvidenceIds);
    for (const evidenceId of decisionEvidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) continue;
      const rank = rankDecisionEvidence(
        state,
        reason,
        new Set(),
        reasonCausalAnchorIds(state, reason),
        evidence,
        historyIndexById.get(evidenceId) ?? -1,
      );
      const previous = rankedByEvidenceId.get(evidenceId);
      if (!previous || compareRankedEvidence(rank, previous) < 0) {
        rankedByEvidenceId.set(evidenceId, rank);
      }
    }
  }
  const allEvidenceIds = [...rankedByEvidenceId.keys()].sort((left, right) =>
    compareRankedEvidence(rankedByEvidenceId.get(left)!, rankedByEvidenceId.get(right)!),
  );
  const selectedGlobalIds = new Set(allEvidenceIds.slice(0, MAX_DECISION_EVIDENCE_IDS));
  for (const reason of reasons) {
    const selected = (reasonSelections.get(reason.id) ?? [])
      .filter((evidenceId) => selectedGlobalIds.has(evidenceId))
      .sort((left, right) => (historyIndexById.get(left) ?? 0) - (historyIndexById.get(right) ?? 0));
    reasonSelections.set(reason.id, selected);
  }
  return reasonSelections;
}

function hasUnevaluatedEvidence(
  state: AutonomyState,
  reason: CandidateReason,
  decisionEvidenceIds: readonly string[],
): boolean {
  const latestId = decisionEvidenceIds[decisionEvidenceIds.length - 1];
  if (!latestId) return false;
  if (!reason.lastEvaluatedEvidenceId) return true;
  if (latestId === reason.lastEvaluatedEvidenceId) return false;
  const newestEvidenceId = state.evidenceHistory[state.evidenceHistory.length - 1]?.id;
  if (latestId === newestEvidenceId) return true;
  if (reason.lastEvaluatedEvidenceId === newestEvidenceId) return false;
  const latestIndex = state.evidenceHistory.findIndex((item) => item.id === latestId);
  const evaluatedIndex = state.evidenceHistory.findIndex(
    (item) => item.id === reason.lastEvaluatedEvidenceId,
  );
  if (latestIndex >= 0 && evaluatedIndex >= 0) return latestIndex > evaluatedIndex;
  return latestId !== reason.lastEvaluatedEvidenceId;
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
      decisionEvidenceIds: selectDecisionEvidenceForReason(
        state,
        {
          ...existing,
          content,
          salience,
          status: existing.status === 'deferred' ? 'active' : existing.status,
          deferCause: null,
          wakeOn: [],
        },
        [evidence.id],
        now,
      ),
      updatedAt: now,
    };
    return {
      state: replaceStateReason(state, nextReason),
      reason: nextReason,
      changed:
        existing.status !== nextReason.status ||
        existing.content !== nextReason.content ||
        existing.salience !== nextReason.salience ||
        !sameStringList(
          existing.decisionEvidenceIds,
          nextReason.decisionEvidenceIds,
        ),
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
    decisionEvidenceIds: [evidence.id],
    createdAt: now,
    updatedAt: now,
    lastEvaluatedEvidenceId: null,
    mergedIntoReasonId: null,
  };
  const decisionEvidenceIds = selectDecisionEvidenceForReason(
    state,
    reason,
    [evidence.id],
    now,
  );
  return {
    state: {
      ...state,
      reasons: [...state.reasons, { ...reason, decisionEvidenceIds }],
    },
    reason: { ...reason, decisionEvidenceIds },
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

function appendEvidenceHistory(
  state: AutonomyState,
  evidence: AutonomyEvidence,
): AutonomyState {
  if (state.evidenceHistory.some((item) => item.id === evidence.id)) return state;
  return {
    ...state,
    evidenceHistory: [...state.evidenceHistory, evidence],
    version: state.version + 1,
  };
}

function ensureEvidenceInHistory(
  current: AutonomyState,
  evidence: AutonomyEvidence,
): AutonomyState {
  if (
    current.evidenceHistory.some((item) => item.id === evidence.id) ||
    current.processedEvidenceIds.includes(evidence.id)
  ) {
    return current;
  }
  let state = markEvidenceProcessed(current, evidence.id);
  state = appendEvidenceHistory(state, evidence);
  const episode = state.episodes.find((item) => item.id === evidence.episodeId);
  if (!episode) return state;
  const nextEpisode = {
    ...episode,
    lastEvidenceId: evidence.id,
    updatedAt: evidence.at,
  };
  return {
    ...state,
    episodes: state.episodes.map((item) =>
      item.id === nextEpisode.id ? nextEpisode : item,
    ),
    version: state.version + 1,
  };
}

export function createInitialAutonomyState(): AutonomyState {
  return {
    reasons: [],
    episodes: [],
    evidenceHistory: [],
    processedEvidenceIds: [],
    version: 0,
  };
}

export function observeAutonomyEvidence(
  current: AutonomyState,
  evidence: AutonomyEvidence,
): AutonomyState {
  if (
    current.processedEvidenceIds.includes(evidence.id) ||
    current.evidenceHistory.some((item) => item.id === evidence.id)
  ) {
    return current;
  }

  const now = Number.isFinite(evidence.at) ? evidence.at : Date.now();
  let state = markEvidenceProcessed(current, evidence.id);
  let episode = evidence.episodeId
    ? state.episodes.find((item) => item.id === evidence.episodeId) ?? null
    : null;

  const hasReasonProposals = (evidence.reasonProposals?.length ?? 0) > 0;
  if (!episode && !hasReasonProposals) {
    state = appendEvidenceHistory(state, {
      ...evidence,
      at: now,
      episodeId: evidence.episodeId ?? null,
    });
    for (const reason of state.reasons) {
      if (
        reason.status === 'deferred' &&
        evidence.wakeConditions?.some((condition) => reason.wakeOn.includes(condition))
      ) {
        const nextReasonBase: CandidateReason = {
          ...reason,
          status: 'active',
          deferCause: null,
          wakeOn: [],
          updatedAt: now,
        };
        state = replaceStateReason(state, {
          ...nextReasonBase,
          decisionEvidenceIds: selectDecisionEvidenceForReason(
            state,
            nextReasonBase,
            [evidence.id],
            now,
          ),
        });
      }
    }
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

  state = appendEvidenceHistory(state, {
    ...evidence,
    at: now,
    episodeId: episode.id,
  });

  for (const reason of state.reasons) {
    if (
      reason.status === 'deferred' &&
      evidence.wakeConditions?.some((condition) => reason.wakeOn.includes(condition))
    ) {
      const nextReasonBase: CandidateReason = {
        ...reason,
        status: 'active',
        deferCause: null,
        wakeOn: [],
        updatedAt: now,
      };
      state = replaceStateReason(state, {
        ...nextReasonBase,
        decisionEvidenceIds: selectDecisionEvidenceForReason(
          state,
          nextReasonBase,
          [evidence.id],
          now,
        ),
      });
    }
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
  const evidenceByReason = new Map<string, readonly string[]>();
  for (const reason of candidate.reasons) {
    evidenceByReason.set(reason.id, reason.decisionEvidenceIds);
  }
  let changed = false;
  const reasons = current.reasons.map((reason) => {
    const decisionEvidenceIds = evidenceByReason.get(reason.id);
    if (!decisionEvidenceIds) {
      return reason;
    }
    const evidenceId = latestEvidenceId({ ...reason, decisionEvidenceIds });
    if (
      !evidenceId ||
      (reason.lastEvaluatedEvidenceId === evidenceId &&
        sameStringList(reason.decisionEvidenceIds, decisionEvidenceIds))
    ) {
      return reason;
    }
    changed = true;
    return {
      ...reason,
      decisionEvidenceIds,
      lastEvaluatedEvidenceId: evidenceId,
    };
  });
  return changed
    ? { ...current, reasons, version: current.version + 1 }
    : current;
}

export function selectAutonomyCandidate(
  current: AutonomyState,
  readiness: AutonomyReadiness,
  now = Date.now(),
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
  const activeReasons = current.reasons
    .filter(
      (reason) =>
        reason.status === 'active' &&
        activeEpisodeIds.has(reason.episodeId) &&
        reason.decisionEvidenceIds.length > 0,
    )
    .sort((left, right) => right.salience - left.salience)
    .slice(0, MAX_CANDIDATE_REASONS);
  const decisionEvidenceSets = selectDecisionEvidenceSets(
    current,
    activeReasons,
    now,
  );
  const eligible = activeReasons
    .map((reason) => ({
      reason,
      decisionEvidenceIds: decisionEvidenceSets.get(reason.id) ?? [],
    }))
    .filter(({ reason, decisionEvidenceIds }) =>
      hasUnevaluatedEvidence(current, reason, decisionEvidenceIds),
    );
  if (!eligible.length) return null;

  const episodeId = eligible[0].reason.episodeId;
  const reasons = eligible
    .filter(({ reason }) => reason.episodeId === episodeId)
    .map(({ reason, decisionEvidenceIds }) => ({
      ...reason,
      decisionEvidenceIds,
    }));
  const combinedDecisionEvidenceIds = [...new Set(
    reasons.flatMap((reason) => reason.decisionEvidenceIds),
  )];
  const decisionEvidenceIds =
    reasons.length === 1
      ? combinedDecisionEvidenceIds.slice(0, MAX_DECISION_EVIDENCE_IDS)
      : combinedDecisionEvidenceIds
          .map((evidenceId) => ({
            evidenceId,
            historyIndex: current.evidenceHistory.findIndex(
              (evidence) => evidence.id === evidenceId,
            ),
          }))
          .sort((left, right) => left.historyIndex - right.historyIndex)
          .slice(0, MAX_DECISION_EVIDENCE_IDS)
          .map(({ evidenceId }) => evidenceId);
  return {
    episodeId,
    reasons,
    decisionEvidenceIds,
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
  const deltaEvidence: AutonomyEvidence = {
    id: context.evidenceId,
    kind: 'internal_state_change',
    at,
    semanticKey: 'autonomy-delta',
    episodeId: context.episodeId,
  };
  let state = ensureEvidenceInHistory(current, deltaEvidence);
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
          ...deltaEvidence,
          semanticKey: update.semanticKey,
          reasonProposals: [proposal],
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
        updatedAt: at,
      };
      nextReason.decisionEvidenceIds = selectDecisionEvidenceForReason(
        state,
        nextReason,
        [context.evidenceId],
        at,
      );
      state = replaceStateReason(state, nextReason);
      changed ||=
        nextReason.content !== reason.content ||
        nextReason.salience !== reason.salience ||
        nextReason.status !== reason.status ||
        nextReason.deferCause !== reason.deferCause ||
        nextReason.wakeOn.length !== reason.wakeOn.length ||
        !sameStringList(
          nextReason.decisionEvidenceIds,
          reason.decisionEvidenceIds,
        );
      continue;
    }

    if (update.operation === 'reactivate') {
      if (!['deferred', 'expired'].includes(reason.status)) {
        rejectedUpdates.push('reactivate:invalid-status');
        continue;
      }
      const nextReason: CandidateReason = {
        ...reason,
        status: 'active',
        salience: normalizeSalience(
          reason.salience + (update.salienceDelta ?? 0),
        ),
        deferCause: null,
        wakeOn: [],
        updatedAt: at,
      };
      state = replaceStateReason(state, {
        ...nextReason,
        decisionEvidenceIds: selectDecisionEvidenceForReason(
          state,
          nextReason,
          [context.evidenceId],
          at,
        ),
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
