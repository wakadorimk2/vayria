import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateDirectionContributions,
  applyPlanLocalModifiers,
  createActionIntent,
  createInitialPerformerState,
  DEFAULT_SPEECH_MOTION_ASSET_ID,
  getEffectIntensity,
  getNextAutonomousDelay,
  reducePerformanceResult,
  resolvePerformancePlan,
  schedulePerformancePlan,
} from '../src/performer/runtime.js';
import { DEFAULT_PERFORMER_PROFILE } from '../src/performer/profile.js';
import { CARD_BEHAVIORS, CARD_MODIFIERS } from '../src/cards/cardReactions.js';
import type {
  DirectionContribution,
  DirectionEffect,
  DirectionModifiers,
  PerformanceResult,
  PerformerState,
  PerformerTrigger,
} from '../src/performer/types.js';

const ZERO_MODIFIERS: DirectionModifiers = {
  responseDelayMs: 0,
  initiative: 0,
  emotionalInertia: 0,
  speechFragmentation: 0,
  callbackTendency: 0,
  gazeDirectness: 0,
  attentionStrength: 0,
  energy: 0,
  ttsRateScale: 0,
  ttsIntonationScale: 0,
  idleMotionWeight: 0,
  headYawBias: 0,
  semanticBiases: [],
};

function createEffect(
  id: string,
  modifiers: Partial<DirectionModifiers>,
): DirectionEffect {
  return {
    id,
    directionId: id,
    sourceId: id,
    startedAt: 0,
    intensity: 1,
    decay: 'none',
    modifiers,
  };
}

function createContribution(
  directionId: string,
  effects: DirectionEffect[],
  overrides: Partial<DirectionContribution> = {},
): DirectionContribution {
  return {
    directionId,
    effects,
    constraints: [],
    semanticCues: [],
    triggers: [],
    ...overrides,
  };
}

function createState(overrides: Partial<PerformerState> = {}): PerformerState {
  return {
    ...createInitialPerformerState(100),
    ...overrides,
  };
}

function createModifiers(
  overrides: Partial<DirectionModifiers> = {},
): DirectionModifiers {
  return { ...ZERO_MODIFIERS, ...overrides };
}

test('exponential effects decay and expire at their lifetime boundary', () => {
  const effect: DirectionEffect = {
    ...createEffect('forced', {}),
    durationMs: 1_000,
    decay: 'exponential',
  };

  assert.equal(getEffectIntensity(effect, 0), 1);
  assert.ok(getEffectIntensity(effect, 500) > 0.2);
  assert.ok(getEffectIntensity(effect, 500) < 0.3);
  assert.equal(getEffectIntensity(effect, 1_000), 0);
});

test('direction aggregation is independent of contribution order', () => {
  const first = createContribution(
    'direction-b',
    [
      createEffect('effect-b', {
        responseDelayMs: 120,
        energy: 0.1,
        semanticBiases: ['zeta'],
      }),
    ],
    { semanticCues: ['beta'] },
  );
  const second = createContribution(
    'direction-a',
    [
      createEffect('effect-a', {
        responseDelayMs: -40,
        energy: -0.2,
        semanticBiases: ['alpha'],
      }),
    ],
    { semanticCues: ['gamma'] },
  );

  const forward = aggregateDirectionContributions([first, second], 0);
  const reverse = aggregateDirectionContributions([second, first], 0);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.activeDirectionIds, ['effect-a', 'effect-b']);
  assert.deepEqual(forward.semanticCues, ['alpha', 'beta', 'gamma', 'zeta']);
});

test('opaque external stimulus uses the neutral Core baseline', () => {
  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: 'something_changed',
    metadata: { origin: 'wildcard' },
  };
  const intent = createActionIntent(trigger, createState());

  assert.equal(intent.preferredIntent, 'react_nonverbally');
  assert.deepEqual(trigger.metadata, { origin: 'wildcard' });
});

test('require_speech and attention target are Direction contributions', () => {
  assert.equal(DEFAULT_SPEECH_MOTION_ASSET_ID, 'speech-gentle');
  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: 'something_changed',
    metadata: { origin: 'wildcard' },
  };
  const intent = createActionIntent(trigger, createState());
  const contribution = createContribution('wildcard', [], {
    attentionTarget: 'viewer',
    constraints: [{ kind: 'require_speech', scope: 'current_plan' }],
  });
  const plan = resolvePerformancePlan(
    intent,
    [contribution],
    createState(),
    DEFAULT_PERFORMER_PROFILE,
    100,
  );

  assert.equal(plan.intent, 'speak');
  assert.equal(plan.preReaction?.gaze?.target, 'viewer');
  assert.equal(
    plan.preReaction?.leadBeforeSpeechMs,
    DEFAULT_PERFORMER_PROFILE.leadBeforeSpeechMs,
  );
  assert.equal(plan.motion?.assetId, DEFAULT_SPEECH_MOTION_ASSET_ID);
  assert.deepEqual(plan.timing, {
    motionLeadMs: DEFAULT_PERFORMER_PROFILE.motionLeadMs,
    motionEnterBlendMs: DEFAULT_PERFORMER_PROFILE.motionEnterBlendMs,
    motionExitBlendMs: DEFAULT_PERFORMER_PROFILE.motionExitBlendMs,
    motionPreparationTimeoutMs:
      DEFAULT_PERFORMER_PROFILE.motionPreparationTimeoutMs,
    postSpeechHoldMs: DEFAULT_PERFORMER_PROFILE.postSpeechHoldMs,
  });
});

test('card plan overrides reach the plan before speech motion fallback', () => {
  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: 'something_changed:sleepy',
    metadata: { origin: 'wildcard' },
  };
  const intent = createActionIntent(trigger, createState());
  const contribution = createContribution(
    'wildcard',
    [createEffect('forced:sleepy', CARD_MODIFIERS.sleepy)],
    {
      attentionTarget: 'viewer',
      constraints: [{ kind: 'require_speech', scope: 'current_plan' }],
      planOverrides: {
        behavior: CARD_BEHAVIORS.sleepy,
        motion: { assetId: 'card-sleepy' },
      },
    },
  );
  const plan = resolvePerformancePlan(
    intent,
    [contribution],
    createState(),
    DEFAULT_PERFORMER_PROFILE,
    0,
  );

  assert.equal(plan.intent, 'speak');
  assert.deepEqual(plan.behavior, CARD_BEHAVIORS.sleepy);
  assert.equal(plan.motion?.assetId, 'card-sleepy');
  assert.notEqual(plan.motion?.assetId, DEFAULT_SPEECH_MOTION_ASSET_ID);
  assert.equal(plan.preReaction?.gaze?.target, 'viewer');
  assert.ok((plan.preReaction?.leadBeforeSpeechMs ?? Infinity) <= 500);
  const sleepyResponseDelayMs = CARD_MODIFIERS.sleepy.responseDelayMs ?? 0;
  assert.equal(
    plan.speech?.delayMs,
    DEFAULT_PERFORMER_PROFILE.responseDelayBaselineMs +
      sleepyResponseDelayMs,
  );
  assert.equal(plan.ttsProfile?.rateScale, 0.88);

  const reducedPlan = resolvePerformancePlan(
    intent,
    [
      createContribution('wildcard', [], {
        constraints: [{ kind: 'require_speech', scope: 'current_plan' }],
        planOverrides: { behavior: CARD_BEHAVIORS.sleepy },
      }),
    ],
    createState(),
    DEFAULT_PERFORMER_PROFILE,
    0,
  );
  assert.deepEqual(reducedPlan.behavior, CARD_BEHAVIORS.sleepy);
  assert.equal(reducedPlan.motion, undefined);
});

test('the first plan override follows sorted direction order', () => {
  const first = createContribution('direction-b', [], {
    planOverrides: { motion: { assetId: 'wrong-order' } },
  });
  const second = createContribution('direction-a', [], {
    planOverrides: { motion: { assetId: 'sorted-first' } },
  });

  const forward = aggregateDirectionContributions([first, second], 0);
  const reverse = aggregateDirectionContributions([second, first], 0);

  assert.deepEqual(forward.planOverrides, {
    motion: { assetId: 'sorted-first' },
  });
  assert.deepEqual(forward.planOverrides, reverse.planOverrides);
});

test('default speech motion is not assigned to non-speech plans', () => {
  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: 'silent_reaction',
  };
  const intent = createActionIntent(trigger, createState());
  const plan = resolvePerformancePlan(
    intent,
    [],
    createState(),
    DEFAULT_PERFORMER_PROFILE,
    100,
  );

  assert.equal(plan.intent, 'react_nonverbally');
  assert.equal(plan.motion, undefined);
});

test('performance timing is clamped without changing response lead timing', () => {
  const trigger: PerformerTrigger = {
    kind: 'viewer_message',
    text: 'timing',
  };
  const profile = {
    ...DEFAULT_PERFORMER_PROFILE,
    leadBeforeSpeechMs: 240,
    motionLeadMs: 999,
    motionEnterBlendMs: 9_999,
    motionExitBlendMs: -10,
    motionPreparationTimeoutMs: 9_999,
    postSpeechHoldMs: -10,
  };
  const plan = resolvePerformancePlan(
    createActionIntent(trigger, createState(), profile),
    [],
    createState(),
    profile,
    100,
  );

  assert.equal(plan.preReaction?.leadBeforeSpeechMs, 240);
  assert.deepEqual(plan.timing, {
    motionLeadMs: 300,
    motionEnterBlendMs: 1_000,
    motionExitBlendMs: 0,
    motionPreparationTimeoutMs: 1_500,
    postSpeechHoldMs: 0,
  });
});

test('normal runtime plans remain free of Card Preview behavior state', () => {
  const trigger: PerformerTrigger = {
    kind: 'viewer_message',
    text: 'こんにちは',
  };
  const plan = resolvePerformancePlan(
    createActionIntent(trigger, createState()),
    [],
    createState(),
    DEFAULT_PERFORMER_PROFILE,
    100,
  );

  assert.equal(plan.behavior, undefined);
});

test('emotion inertia blends the cue with the previous emotion', () => {
  const previousState = createState({
    emotion: { value: 'joy', activation: 0.8, updatedAt: 100 },
  });
  const result: PerformanceResult = {
    planId: 'plan-1',
    completedAt: 100,
    outcome: 'completed',
    trigger: 'viewer_message',
    intent: 'speak',
    spokenText: '返答',
    emotionCue: { emotion: 'angry', intensity: 0.5 },
    speechEndedAt: 100,
  };

  const nextState = reducePerformanceResult(previousState, result);

  assert.equal(nextState.emotion.value, 'angry');
  assert.ok(nextState.emotion.activation < 0.8);
  assert.ok(nextState.emotion.activation > 0.4);
});

test('cancelled and interrupted results do not apply completed speech state', () => {
  const previousState = createState({
    phase: 'speaking',
    energy: 0.4,
    emotion: { value: 'joy', activation: 0.7, updatedAt: 100 },
    lastSpeechAt: 50,
  });

  for (const outcome of ['cancelled', 'interrupted'] as const) {
    const nextState = reducePerformanceResult(previousState, {
      planId: `plan-${outcome}`,
      completedAt: 100,
      outcome,
      trigger: 'viewer_message',
      intent: 'speak',
      spokenText: '未完了の返答',
      emotionCue: { emotion: 'angry', intensity: 1 },
    });

    assert.equal(nextState.phase, 'idle');
    assert.equal(nextState.energy, previousState.energy);
    assert.deepEqual(nextState.emotion, previousState.emotion);
    assert.equal(nextState.lastSpeechAt, previousState.lastSpeechAt);
  }
});

test('failed results return to idle without applying completed speech state', () => {
  const previousState = createState({
    phase: 'synthesizing',
    energy: 0.4,
    emotion: { value: 'joy', activation: 0.7, updatedAt: 100 },
    lastSpeechAt: 50,
  });

  const nextState = reducePerformanceResult(previousState, {
    planId: 'plan-failed',
    completedAt: 100,
    outcome: 'failed',
    trigger: 'idle_tick',
    intent: 'speak',
    spokenText: '失敗した返答',
    emotionCue: { emotion: 'angry', intensity: 1 },
  });

  assert.equal(nextState.phase, 'idle');
  assert.equal(nextState.energy, previousState.energy);
  assert.deepEqual(nextState.emotion, previousState.emotion);
  assert.equal(nextState.lastSpeechAt, previousState.lastSpeechAt);
});

test('initiative changes autonomous cadence while preserving the initial delay', () => {
  const state = createState();
  const lowInitiative = {
    ...DEFAULT_PERFORMER_PROFILE,
    initiativeBaseline: 0,
  };
  const highInitiative = {
    ...DEFAULT_PERFORMER_PROFILE,
    initiativeBaseline: 1,
  };

  assert.equal(getNextAutonomousDelay(state, highInitiative, true, () => 0.5), 4_000);
  assert.ok(
    getNextAutonomousDelay(state, highInitiative, false, () => 0.5) <
      getNextAutonomousDelay(state, lowInitiative, false, () => 0.5),
  );
});

test('energy and attention modifiers remain plan-local', () => {
  const state = createState({
    energy: 0.4,
    attention: { target: 'viewer', strength: 0.5, updatedAt: 100 },
  });
  const nextState = applyPlanLocalModifiers(
    state,
    createModifiers({ energy: 0.25, attentionStrength: 0.4 }),
  );
  const intent = createActionIntent(
    { kind: 'viewer_message', text: 'hello' },
    nextState,
  );
  const attentionContribution = createContribution('attention', [
    createEffect('attention-effect', { attentionStrength: 0.4 }),
  ]);
  const plan = resolvePerformancePlan(
    intent,
    [attentionContribution],
    state,
    DEFAULT_PERFORMER_PROFILE,
    100,
  );
  const scheduledState = schedulePerformancePlan(state, plan);

  assert.equal(nextState.energy, 0.65);
  assert.deepEqual(nextState.attention, state.attention);
  assert.deepEqual(scheduledState.attention, state.attention);
  assert.equal(scheduledState.energy, state.energy);
  assert.equal(
    plan.preReaction?.gaze?.directness,
    Math.min(1, DEFAULT_PERFORMER_PROFILE.gazeDirectnessBaseline + 0.4),
  );
});
