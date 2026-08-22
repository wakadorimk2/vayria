import assert from 'node:assert/strict';
import test from 'node:test';
import { cardPool } from '../src/cards/cardPool.js';
import {
  CARD_BEHAVIORS,
  CARD_INTERACTION_ATTENTION_CHANCE,
  CARD_MODIFIERS,
  CARD_REACTION_AXES,
  CARD_REACTION_MODIFIER_FIELDS,
  CARD_REACTION_PROFILES,
  CARD_REACTION_VISIBLE_FIELDS,
  createCardPreviewContribution,
  M1_INITIAL_BRAIN_CARD_IDS,
  shouldReactToCardInteraction,
} from '../src/cards/cardReactions.js';

const EXPECTED_M1_CARD_IDS = [
  'chicken',
  'suspicious',
  'sleepy',
  'rain',
  'gigantic',
] as const;

test('M1 keeps the initial five cards and five axes stable', () => {
  assert.deepEqual(M1_INITIAL_BRAIN_CARD_IDS, EXPECTED_M1_CARD_IDS);
  assert.equal(new Set(M1_INITIAL_BRAIN_CARD_IDS).size, 5);
  assert.deepEqual(
    CARD_REACTION_AXES.map((axis) => axis.id),
    ['meaning', 'speech', 'gaze', 'voice', 'motion'],
  );
  assert.deepEqual(Object.keys(CARD_REACTION_MODIFIER_FIELDS), [
    'meaning',
    'speech',
    'gaze',
    'voice',
    'motion',
  ]);
});

test('every card has a five-axis profile and a visible runtime modifier', () => {
  assert.deepEqual(
    Object.keys(CARD_REACTION_PROFILES).sort(),
    cardPool.map((card) => card.id).sort(),
  );

  for (const card of cardPool) {
    const cardId = card.id;
    assert.ok(cardPool.some((card) => card.id === cardId));

    const profile = CARD_REACTION_PROFILES[cardId];
    assert.ok(profile);
    assert.equal(profile.cardId, cardId);
    assert.deepEqual(
      Object.keys(profile.axisSummaries),
      ['meaning', 'speech', 'gaze', 'voice', 'motion'],
    );
    assert.deepEqual(profile.modifiers, CARD_MODIFIERS[cardId]);
    assert.deepEqual(profile.behavior, CARD_BEHAVIORS[cardId]);
    assert.deepEqual(Object.keys(profile.behavior), [
      'stance',
      'energy',
      'engagement',
      'gestureIntent',
    ]);
    assert.ok(
      CARD_REACTION_VISIBLE_FIELDS.some((field) => {
        const value = profile.modifiers[field];
        return typeof value === 'number' && value !== 0;
      }),
    );
  }
});

test('every card has a unique complete behavior state', () => {
  assert.deepEqual(
    Object.keys(CARD_BEHAVIORS).sort(),
    cardPool.map((card) => card.id).sort(),
  );

  const gestureIntents = cardPool.map(
    (card) => CARD_BEHAVIORS[card.id]?.gestureIntent,
  );
  assert.equal(new Set(gestureIntents).size, cardPool.length);
  assert.ok(gestureIntents.every(Boolean));
});

test('M1 profiles preserve the current runtime modifier values', () => {
  assert.deepEqual(CARD_MODIFIERS.chicken.semanticBiases, [
    '鶏に関係する具体物を一つ連想する',
  ]);
  assert.equal(CARD_MODIFIERS.suspicious.responseDelayMs, 260);
  assert.equal(CARD_MODIFIERS.suspicious.emotionalInertia, 0.28);
  assert.equal(CARD_MODIFIERS.suspicious.speechFragmentation, 0.12);
  assert.equal(CARD_MODIFIERS.suspicious.gazeDirectness, -0.35);
  assert.equal(CARD_MODIFIERS.suspicious.ttsIntonationScale, -0.08);
  assert.equal(CARD_MODIFIERS.sleepy.responseDelayMs, 180);
  assert.equal(CARD_MODIFIERS.sleepy.initiative, -0.25);
  assert.equal(CARD_MODIFIERS.sleepy.idleMotionWeight, -0.25);
  assert.equal(CARD_MODIFIERS.sleepy.headYawBias, -0.8);
  assert.deepEqual(CARD_MODIFIERS.rain.semanticBiases, [
    '雨音や湿り気を短く連想する',
  ]);
  assert.deepEqual(CARD_MODIFIERS.gigantic.semanticBiases, [
    '物事を一箇所だけ大きなスケールで見る',
  ]);
});

test('card preview contribution forces speech and viewer attention', () => {
  const contribution = createCardPreviewContribution('rain', 123);

  assert.equal(contribution.directionId, 'card-preview');
  assert.deepEqual(contribution.constraints, [
    { kind: 'require_speech', scope: 'current_plan' },
  ]);
  assert.equal(contribution.attentionTarget, 'viewer');
  assert.deepEqual(contribution.planOverrides, {
    behavior: CARD_BEHAVIORS.rain,
  });
  assert.deepEqual(contribution.triggers[0], {
    kind: 'external_stimulus',
    semanticCue: 'card_preview:rain',
    metadata: { origin: 'card-preview' },
  });
  assert.equal(contribution.effects.length, 1);
  assert.equal(contribution.effects[0].startedAt, 123);
  assert.equal(contribution.effects[0].durationMs, 30_000);
  assert.equal(contribution.effects[0].decay, 'exponential');
  assert.deepEqual(contribution.effects[0].modifiers, CARD_MODIFIERS.rain);
});

test('every card preview contribution carries its behavior override', () => {
  for (const card of cardPool) {
    const contribution = createCardPreviewContribution(card.id, 0);

    assert.deepEqual(
      contribution.planOverrides?.behavior,
      CARD_BEHAVIORS[card.id],
      card.id,
    );
    assert.equal(contribution.planOverrides?.motion, undefined, card.id);
  }
});

test('card interaction attention uses a strict 35 percent boundary', () => {
  assert.equal(CARD_INTERACTION_ATTENTION_CHANCE, 0.35);
  assert.equal(shouldReactToCardInteraction(() => 0.34), true);
  assert.equal(shouldReactToCardInteraction(() => 0.35), false);
  assert.equal(shouldReactToCardInteraction(() => Number.NaN), false);
});
