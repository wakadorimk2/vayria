import assert from 'node:assert/strict';
import test from 'node:test';
import { hasFreshViewerFace, ViewerArrivalController } from '../src/attention/viewerArrival.js';
import { DEFAULT_PROGRAM_CONTEXT, isProgramContext } from '../src/conversation/programContext.js';
import { buildProgramContextDynamicPrompt } from '../server/chatGeneration.js';
import { createViewerNoticePlan } from '../src/performer/viewerNotice.js';
import { createActionIntent, createInitialPerformerState, resolvePerformancePlan } from '../src/performer/runtime.js';
import { EmotionExpressionController } from '../src/avatar/EmotionExpressionController.js';
import type { VRM } from '@pixiv/three-vrm';

test('notice stays local, short and motion-free under reduced motion', () => {
  const state = createInitialPerformerState(0);
  const intent = createActionIntent({ kind: 'external_stimulus', semanticCue: 'viewer_attention' }, state);
  const plan = createViewerNoticePlan(resolvePerformancePlan(intent, [], state), true);
  assert.equal(plan.intent, 'react_nonverbally');
  assert.equal(plan.speech, undefined);
  assert.equal(plan.motion, undefined);
  assert.equal(plan.preReaction?.motion, undefined);
  assert.equal(plan.preReaction?.gaze?.target, 'viewer');
  assert.equal(plan.preReaction?.expression?.intensity, 0.24);
  assert.equal(plan.preReaction?.leadBeforeSpeechMs, 850);
});

test('soft expression intensity survives transition and clamps invalid values', () => {
  const weights = new Map<string, number>();
  const controller = new EmotionExpressionController({ expressionManager: {
    getExpression: (name: string) => ({ expressionName: name }),
    setValue: (name: string, value: number) => weights.set(name, value),
  } } as unknown as VRM);
  controller.setEmotion('joy', 0, 0.24);
  for (let i = 0; i < 4; i += 1) controller.update(0.1);
  assert.equal(weights.get(controller.getExpressionName('joy')!), 0.24);
  controller.setEmotion('joy', 0, 9);
  for (let i = 0; i < 4; i += 1) controller.update(0.1);
  assert.equal(weights.get(controller.getExpressionName('joy')!), 1);
  controller.setEmotion('joy', 0, NaN);
  for (let i = 0; i < 4; i += 1) controller.update(0.1);
  assert.equal(weights.get(controller.getExpressionName('joy')!), 0);
  controller.dispose();
  assert.ok([...weights.values()].every((value) => value === 0));
});

test('three-party generation context preserves anonymous shared input in both activities', () => {
  for (const card of [false, true]) {
    const context = { ...DEFAULT_PROGRAM_CONTEXT, participantRole: 'shared_microphone_group' as const,
      ...(card ? {} : { format: 'live_conversation' as const, objective: 'converse_freely' as const }) };
    assert.equal(isProgramContext(context), true);
    const prompt = buildProgramContextDynamicPrompt(context);
    assert.match(prompt, /Both humans share one microphone/);
    assert.match(prompt, /Never assign an unidentified statement/);
    assert.match(prompt, /Listen while the two humans exchange turns/);
  }
});

test('conversation context accepts only matching objective and omits the card segment', () => {
  const context = { ...DEFAULT_PROGRAM_CONTEXT, format: 'live_conversation' as const,
    objective: 'converse_freely' as const };
  assert.equal(isProgramContext(context), true);
  assert.equal(isProgramContext(DEFAULT_PROGRAM_CONTEXT), true);
  assert.equal(isProgramContext({ ...context, objective: 'notice_card_change' }), false);
  assert.equal(isProgramContext({ ...context, extra: true }), false);
  const prompt = buildProgramContextDynamicPrompt(context);
  assert.match(prompt, /live conversation/);
  assert.doesNotMatch(prompt, /live card-impression segment/);
  assert.match(buildProgramContextDynamicPrompt(DEFAULT_PROGRAM_CONTEXT), /live card-impression segment/);
});

test('sustained detection offers one arrival; continuous presence never repeats', () => {
  const controller = new ViewerArrivalController();
  assert.equal(controller.update(0, true, true), null);
  assert.equal(controller.update(600, true, true), 'notice');
  assert.equal(controller.update(1000, true, true), null);
  assert.equal(controller.update(1450, true, true), 'arrival');
  assert.equal(controller.update(90000, true, true), null);
});

test('brief loss does not greet again; departure and cooldown are both required', () => {
  const controller = new ViewerArrivalController();
  controller.update(0, true, true);
  controller.update(1000, true, true);
  controller.update(1850, true, true);
  controller.update(2000, false, true);
  assert.equal(controller.update(3000, true, true), null);
  controller.update(4000, false, true);
  assert.equal(controller.update(12000, false, true), 'departure');
  controller.update(13000, true, true);
  assert.equal(controller.update(14000, true, true), 'notice');
  assert.equal(controller.update(15000, true, true), null);
  assert.equal(controller.update(47000, true, true), 'arrival');
});

test('busy or listening visitor is not interrupted and absence cancels pending arrival', () => {
  const controller = new ViewerArrivalController();
  controller.update(0, true, false, false);
  assert.equal(controller.update(2000, true, false, false), null);
  controller.update(3000, false, true);
  assert.equal(controller.update(9000, false, true), null);
  controller.update(10000, true, true);
  assert.equal(controller.update(11000, true, true), 'notice');
  assert.equal(controller.update(11850, true, true), 'arrival');
});

test('a human turn consumes the welcome and hiding the page does not invent a new visitor', () => {
  const controller = new ViewerArrivalController();
  controller.update(0, true, true);
  controller.update(600, true, true);
  controller.consumeGreeting();
  assert.equal(controller.update(1600, true, true), null);
  controller.pause();
  assert.equal(controller.update(90000, true, true), null);
  assert.equal(controller.update(92000, true, true), null);
});

test('only fresh, confident face observations count', () => {
  const face = { position: { x: 0, y: 0 }, confidence: 1, updatedAt: 1000 };
  assert.equal(hasFreshViewerFace(face, 1500), true);
  assert.equal(hasFreshViewerFace(face, 2001), false);
  assert.equal(hasFreshViewerFace(face, 999), false);
  assert.equal(hasFreshViewerFace({ ...face, position: null }, 1500), false);
  assert.equal(hasFreshViewerFace({ ...face, confidence: 0.2 }, 1500), false);
});
