import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_GAZE_OVERRIDE_TIMING,
  getCardGazeOverrideWeights,
  type CardGazeBaseContext,
} from '../src/avatar/cardGazeOverride.js';
import type { AttentionGazeOverride } from '../src/performer/types.js';

function createOverride(
  overrides: Partial<AttentionGazeOverride> = {},
): AttentionGazeOverride {
  return {
    kind: 'card-drag',
    target: 'game',
    spatialTarget: { kind: 'game', anchor: 'transient' },
    elapsedMs: 0,
    energy: 0.55,
    viewerCheckIn: false,
    ...overrides,
  };
}

test('card drag keeps state-specific eye capture weights', () => {
  const expected: Record<CardGazeBaseContext, number> = {
    free: 1,
    viewer: 0.9,
    dialogue: 0.6,
  };

  for (const context of Object.keys(expected) as CardGazeBaseContext[]) {
    const weights = getCardGazeOverrideWeights(createOverride(), context);
    assert.equal(weights.eye, expected[context]);
    assert.equal(weights.head, 0);
    assert.equal(weights.neck, 0);
  }
});

test('head and neck join after their configured dwell windows', () => {
  const beforeHead = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: CARD_GAZE_OVERRIDE_TIMING.headStartMs }),
    'free',
  );
  const midHead = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: 350 }),
    'free',
  );
  const fullHead = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: CARD_GAZE_OVERRIDE_TIMING.headFullMs }),
    'free',
  );
  const beforeNeck = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: CARD_GAZE_OVERRIDE_TIMING.neckStartMs }),
    'free',
  );
  const fullNeck = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: CARD_GAZE_OVERRIDE_TIMING.neckFullMs }),
    'free',
  );

  assert.equal(beforeHead.head, 0);
  assert.ok(midHead.head > 0 && midHead.head < 0.6);
  assert.equal(fullHead.head, 0.6);
  assert.equal(beforeNeck.neck, 0);
  assert.equal(fullNeck.neck, 0.2);
});

test('viewer check-ins release only the eye override', () => {
  const weights = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: 2_000, viewerCheckIn: true }),
    'viewer',
  );

  assert.equal(weights.eye, 0);
  assert.ok(weights.head > 0);
  assert.ok(weights.neck > 0);
  assert.equal(weights.viewerCheckIn, true);

  const free = getCardGazeOverrideWeights(
    createOverride({ elapsedMs: 2_000, viewerCheckIn: true }),
    'free',
  );
  assert.equal(free.eye, 1);
  assert.equal(free.viewerCheckIn, false);
});

test('transient card cues keep their energy envelope', () => {
  const weights = getCardGazeOverrideWeights(
    createOverride({ kind: 'card-transient', energy: 0.4 }),
    'viewer',
  );

  assert.ok(Math.abs(weights.eye - 0.36) < 0.000001);
});
