import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CardDropReactionController,
  createCardDropReactionContribution,
  readCardDropReactionMode,
  type CardDropSwapResult,
} from '../src/cards/cardDropReaction.js';

function createSwap(
  overrides: Partial<CardDropSwapResult> = {},
): CardDropSwapResult {
  return {
    animationSequence: 1,
    brainCardIds: ['curious', 'sleepy', 'panic'],
    ejectedCardId: 'chicken',
    forcedCardId: 'curious',
    insertedCardId: 'curious',
    ...overrides,
  };
}

test('card drop reaction defaults to baseline and supports an independent candidate toggle', () => {
  assert.equal(readCardDropReactionMode('', undefined), 'baseline');
  assert.equal(
    readCardDropReactionMode('', 'candidate'),
    'candidate',
  );
  assert.equal(
    readCardDropReactionMode('?cardDropReaction=baseline', 'candidate'),
    'baseline',
  );
  assert.equal(
    readCardDropReactionMode('?cardDropReaction=invalid', 'invalid'),
    'baseline',
  );
});

test('baseline, failed swap, and cancelled drag do not start a reaction', () => {
  const controller = new CardDropReactionController();
  assert.equal(controller.begin(createSwap(), 'baseline', false), null);
  assert.equal(controller.begin(null, 'candidate', false), null);
  assert.deepEqual(controller.snapshot(), {
    activeCardId: null,
    animationSequence: null,
    phase: 'idle',
    reactionPlanId: null,
    replyPlanId: null,
  });
});

test('a successful swap starts one speech-free reaction for the inserted card', () => {
  const controller = new CardDropReactionController();
  const swap = createSwap();
  const start = controller.begin(swap, 'candidate', false);

  assert.ok(start);
  assert.equal(start.activeCardId, swap.insertedCardId);
  assert.equal(start.trigger.kind, 'external_stimulus');
  assert.deepEqual(start.contribution.constraints, []);
  assert.equal(start.contribution.attentionTarget, 'game');
  assert.equal(start.contribution.directionId, 'wildcard-card-drop');
  assert.ok(start.contribution.planOverrides?.motion);
  assert.equal(controller.begin(swap, 'candidate', false), null);
  assert.equal(controller.snapshot().activeCardId, swap.forcedCardId);
});

test('reduced motion keeps behavior and suppresses the card motion asset', () => {
  const contribution = createCardDropReactionContribution(
    createSwap(),
    true,
  );
  assert.ok(contribution.planOverrides?.behavior);
  assert.equal(contribution.planOverrides?.motion, undefined);

  const controller = new CardDropReactionController();
  assert.equal(controller.begin(createSwap(), 'baseline', true), null);
});

test('a second drop supersedes old state and ignores the stale plan callback', () => {
  const controller = new CardDropReactionController();
  controller.begin(createSwap({ animationSequence: 1 }), 'candidate', false);
  controller.bindReactionPlan('stale-drop-plan');

  controller.begin(
    createSwap({
      animationSequence: 2,
      forcedCardId: 'panic',
      insertedCardId: 'panic',
    }),
    'candidate',
    false,
  );

  assert.equal(
    controller.settleReaction('stale-drop-plan', 'completed'),
    false,
  );
  assert.deepEqual(controller.snapshot(), {
    activeCardId: 'panic',
    animationSequence: 2,
    phase: 'reacting',
    reactionPlanId: null,
    replyPlanId: null,
  });
});

test('completed non-speech reaction hands off once to the matching reply', () => {
  const controller = new CardDropReactionController();
  controller.begin(createSwap(), 'candidate', false);
  assert.equal(controller.bindReactionPlan('drop-plan'), true);
  assert.equal(controller.settleReaction('drop-plan', 'completed'), true);
  assert.equal(controller.snapshot().phase, 'awaiting-reply');
  assert.equal(controller.handoffToReply('panic', 'reply-plan'), false);
  assert.equal(controller.handoffToReply('curious', 'reply-plan'), true);
  assert.equal(controller.handoffToReply('curious', 'duplicate'), false);
  assert.equal(controller.snapshot().phase, 'reply-active');
  assert.equal(controller.settleReply('reply-plan'), true);
  assert.equal(controller.snapshot().phase, 'idle');
});

test('reply handoff preparation preserves matching card state across interruption', () => {
  const controller = new CardDropReactionController();
  controller.begin(createSwap(), 'candidate', false);
  controller.bindReactionPlan('drop-plan');

  assert.equal(controller.prepareReplyHandoff('panic'), false);
  assert.equal(controller.prepareReplyHandoff('curious'), true);
  assert.equal(controller.settleReaction('drop-plan', 'cancelled'), false);
  assert.equal(controller.handoffToReply('curious', 'manual-plan'), true);
  assert.equal(controller.handoffToReply('curious', 'duplicate-plan'), false);
  assert.equal(controller.snapshot().phase, 'reply-active');
});

test('reply handoff preparation supersedes awaiting and active reply plans', () => {
  const controller = new CardDropReactionController();
  controller.begin(createSwap(), 'candidate', false);
  controller.bindReactionPlan('drop-plan');
  controller.settleReaction('drop-plan', 'completed');

  assert.equal(controller.prepareReplyHandoff('curious'), true);
  assert.equal(controller.handoffToReply('curious', 'voice-plan'), true);
  assert.equal(controller.prepareReplyHandoff('curious'), true);
  assert.equal(controller.settleReply('voice-plan'), false);
  assert.equal(controller.handoffToReply('curious', 'replacement-plan'), true);
  assert.equal(controller.settleReply('replacement-plan'), true);
  assert.equal(controller.snapshot().phase, 'idle');
});

test('session reset clears an awaiting reply', () => {
  const controller = new CardDropReactionController();
  controller.begin(createSwap(), 'candidate', false);
  controller.bindReactionPlan('drop-plan');
  controller.settleReaction('drop-plan', 'completed');

  controller.reset();
  assert.deepEqual(controller.snapshot(), {
    activeCardId: null,
    animationSequence: null,
    phase: 'idle',
    reactionPlanId: null,
    replyPlanId: null,
  });
});

test('failure, cancellation, supersede, and reset clear reaction state', () => {
  const controller = new CardDropReactionController();
  for (const outcome of ['failed', 'cancelled', 'interrupted'] as const) {
    controller.begin(
      createSwap({ animationSequence: outcome.length }),
      'candidate',
      false,
    );
    controller.bindReactionPlan(`plan-${outcome}`);
    controller.settleReaction(`plan-${outcome}`, outcome);
    assert.equal(controller.snapshot().phase, 'idle');
  }

  controller.begin(createSwap({ animationSequence: 20 }), 'candidate', false);
  controller.supersede();
  assert.equal(controller.snapshot().activeCardId, null);

  controller.begin(createSwap({ animationSequence: 21 }), 'candidate', false);
  controller.reset();
  assert.equal(controller.snapshot().phase, 'idle');
});
