import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ACTIVE_REASONS,
  MAX_EPISODE_DEPTH,
  MAX_REASON_UPDATES_PER_DELTA,
  applyReasonUpdates,
  completeInactiveEpisodes,
  createInitialAutonomyState,
  deferReasons,
  observeAutonomyEvidence,
  resolveUsedReasons,
  selectAutonomyCandidate,
  type AutonomyEvidence,
} from '../src/conversation/autonomyState.js';

function evidence(
  id: string,
  semanticKey: string,
  content: string,
  kind: AutonomyEvidence['kind'] = 'conversation_input',
  episodeId?: string,
): AutonomyEvidence {
  return {
    id,
    kind,
    at: 1,
    semanticKey,
    content,
    wakeConditions: ['new_evidence'],
    ...(episodeId ? { episodeId } : {}),
    reasonProposals: [
      {
        kind: 'conversation_continuation',
        content,
        semanticKey,
        salience: 0.7,
      },
    ],
  };
}

const READY = {
  enabled: true,
  busy: false,
  floorAvailable: true,
  attentionAvailable: true,
  interactionAvailable: true,
};

test('no reasons means no candidate, even after time passes', () => {
  let state = createInitialAutonomyState();
  state = observeAutonomyEvidence(state, {
    id: 'activity-1',
    kind: 'activity_change',
    at: 1,
    semanticKey: 'still-active',
  });

  assert.equal(state.reasons.length, 0);
  assert.equal(state.episodes.length, 0);
  assert.equal(selectAutonomyCandidate(state, READY), null);
});

test('the same evidence is processed once and does not create a duplicate reason', () => {
  const input = evidence('evidence-1', 'topic:rain', '雨の話');
  const once = observeAutonomyEvidence(createInitialAutonomyState(), input);
  const twice = observeAutonomyEvidence(once, input);

  assert.equal(once.reasons.length, 1);
  assert.equal(twice.reasons.length, 1);
  assert.deepEqual(twice.processedEvidenceIds, ['evidence-1']);
});

test('new evidence can add a new reason while same content is deduplicated', () => {
  let state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  state = observeAutonomyEvidence(
    state,
    evidence('evidence-2', 'topic:rain', '雨の話', 'conversation_input', state.episodes[0].id),
  );
  state = observeAutonomyEvidence(
    state,
    evidence('evidence-3', 'topic:lamp', 'ランプの話', 'conversation_input', state.episodes[0].id),
  );

  assert.equal(state.reasons.length, 2);
  assert.equal(state.reasons[0].evidenceIds.length, 2);
  assert.equal(selectAutonomyCandidate(state, READY)?.reasons.length, 2);
});

test('only used reasons resolve and unused reasons remain active', () => {
  let state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  state = observeAutonomyEvidence(
    state,
    evidence('evidence-2', 'topic:lamp', 'ランプの話', 'conversation_input', state.episodes[0].id),
  );
  const candidate = selectAutonomyCandidate(state, READY)!;
  state = resolveUsedReasons(
    state,
    [candidate.reasons[0].id],
    candidate.episodeId,
  );

  assert.equal(state.reasons.find((reason) => reason.id === candidate.reasons[0].id)?.status, 'resolved');
  assert.equal(state.reasons.find((reason) => reason.id === candidate.reasons[1].id)?.status, 'active');
});

test('deferred reasons wake only on their stored wake condition', () => {
  let state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  const reason = state.reasons[0];
  state = deferReasons(state, [reason.id], 'floor_unavailable', ['floor_available']);
  state = observeAutonomyEvidence(state, {
    id: 'activity-1',
    kind: 'activity_change',
    at: 2,
    semanticKey: 'attention-change',
    wakeConditions: ['attention_available'],
  });
  assert.equal(state.reasons[0].status, 'deferred');

  state = observeAutonomyEvidence(state, {
    id: 'interaction-1',
    kind: 'interaction_state_change',
    at: 3,
    semanticKey: 'floor-open',
    wakeConditions: ['floor_available'],
  });
  assert.equal(state.reasons[0].status, 'active');
});

test('internal delta can add a child reason in the same causal episode', () => {
  const state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  const parent = state.reasons[0];
  const result = applyReasonUpdates(
    state,
    [
      {
        operation: 'create',
        kind: 'new_association',
        content: '窓の反射に気づいた',
        semanticKey: 'association:window-reflection',
        salience: 0.8,
        parentReasonId: parent.id,
      },
    ],
    { episodeId: parent.episodeId, evidenceId: 'delta-1', at: 2 },
  );

  assert.equal(result.createdReasonIds.length, 1);
  assert.equal(result.state.reasons.length, 2);
  assert.equal(result.state.reasons[1].episodeId, parent.episodeId);
  assert.equal(result.state.reasons[1].parentReasonId, parent.id);
});

test('none-style internal delta is stateful without creating an outward candidate by itself', () => {
  const state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  const parent = state.reasons[0];
  const result = applyReasonUpdates(
    state,
    [
      {
        operation: 'create',
        kind: 'new_inference',
        content: 'まだ確認が必要',
        semanticKey: 'inference:needs-check',
        salience: 0.5,
        parentReasonId: parent.id,
      },
    ],
    { episodeId: parent.episodeId, evidenceId: 'delta-2', at: 2 },
  );

  assert.equal(result.state.reasons[1].status, 'active');
  assert.equal(selectAutonomyCandidate(result.state, READY)?.reasons.length, 2);
});

test('episode completes when no reason remains unresolved', () => {
  let state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('evidence-1', 'topic:rain', '雨の話'),
  );
  const reason = state.reasons[0];
  state = resolveUsedReasons(state, [reason.id], reason.episodeId);
  state = completeInactiveEpisodes(state);

  assert.equal(state.episodes[0].status, 'completed');
});

test('safety fuse caps active reasons and delta updates', () => {
  const proposals = Array.from({ length: MAX_ACTIVE_REASONS + 4 }, (_, index) => ({
    kind: 'new_association' as const,
    content: `関連 ${index}`,
    semanticKey: `association:${index}`,
    salience: 0.5,
  }));
  const state = observeAutonomyEvidence(createInitialAutonomyState(), {
    id: 'fuse-evidence',
    kind: 'internal_state_change',
    at: 1,
    semanticKey: 'many-reasons',
    reasonProposals: proposals,
  });
  assert.equal(state.reasons.length, MAX_ACTIVE_REASONS);

  const parent = state.reasons[0];
  const updates = Array.from({ length: MAX_REASON_UPDATES_PER_DELTA + 4 }, (_, index) => ({
    operation: 'create' as const,
    kind: 'new_association' as const,
    content: `delta ${index}`,
    semanticKey: `delta:${index}`,
    salience: 0.4,
    parentReasonId: parent.id,
  }));
  const result = applyReasonUpdates(
    state,
    updates,
    { episodeId: parent.episodeId, evidenceId: 'fuse-delta', at: 2 },
  );
  assert.ok(result.state.reasons.length <= MAX_ACTIVE_REASONS);
  assert.ok(result.createdReasonIds.length <= MAX_REASON_UPDATES_PER_DELTA);
});

test('episode depth fuse stops a causal chain without corrupting its parent', () => {
  let state = observeAutonomyEvidence(
    createInitialAutonomyState(),
    evidence('depth-root', 'depth:root', '根の理由'),
  );

  for (let depth = 1; depth <= MAX_EPISODE_DEPTH + 1; depth += 1) {
    const parent = state.reasons[state.reasons.length - 1];
    state = observeAutonomyEvidence(state, {
      id: `depth-evidence-${depth}`,
      kind: 'internal_state_change',
      at: depth,
      semanticKey: `depth:${depth}`,
      episodeId: `depth-episode-${depth}`,
      parentEpisodeId: parent.episodeId,
      reasonProposals: [
        {
          kind: 'new_association',
          content: `深度 ${depth} の連想`,
          semanticKey: `depth-reason:${depth}`,
          salience: 0.5,
        },
      ],
    });
  }

  const stoppedEpisode = state.episodes[state.episodes.length - 1];
  assert.equal(stoppedEpisode.depth, MAX_EPISODE_DEPTH + 1);
  assert.equal(stoppedEpisode.status, 'safety_stopped');
  assert.equal(state.reasons.length, MAX_EPISODE_DEPTH + 1);
  assert.equal(state.reasons.at(-1)?.content, '深度 8 の連想');
});
