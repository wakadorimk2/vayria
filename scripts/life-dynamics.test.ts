import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLifeDynamicsProfile,
  LifeDynamics,
  resolveLifeDynamicsProfileId,
  type LifeDynamicsInputs,
  type LifeDynamicsSnapshot,
  type RandomSource,
} from '../src/avatar/lifeDynamics.js';

const neutralInputs: LifeDynamicsInputs = {
  arousal: 0,
  curiosity: 0,
  attention: {},
  attentionTarget: null,
  speechUrge: 0,
  inhibition: 0,
  energy: 0.6,
  emotion: 'neutral',
  intent: null,
  gestureIntent: null,
  gestureTrigger: false,
};

function createRandom(values: readonly number[]): RandomSource {
  let index = 0;
  return () => values[index++] ?? 0.5;
}

function withAttention(
  target: string | null,
  strength = 1,
): LifeDynamicsInputs {
  return {
    ...neutralInputs,
    attention: target === null ? {} : { [target]: strength },
    attentionTarget: target,
  };
}

function advance(
  core: LifeDynamics,
  seconds: number,
  inputs: LifeDynamicsInputs,
  random: RandomSource,
  stepSeconds = 0.05,
): LifeDynamicsSnapshot {
  let snapshot = core.update(0, inputs, random);
  let remaining = seconds;
  while (remaining > 0.000001) {
    const delta = Math.min(stepSeconds, remaining);
    snapshot = core.update(delta, inputs, random);
    remaining -= delta;
  }
  return snapshot;
}

test('the same dt and random sequences produce the same snapshot sequence', () => {
  const left = new LifeDynamics();
  const right = new LifeDynamics();
  const leftRandom = createRandom([0.1, 0.8, 0.2, 0.9]);
  const rightRandom = createRandom([0.1, 0.8, 0.2, 0.9]);
  left.reset(leftRandom);
  right.reset(rightRandom);

  const inputs = withAttention('viewer', 0.8);
  for (const delta of [0.016, 0.032, 0.1, 0.05, 0.1]) {
    assert.deepEqual(
      left.update(delta, inputs, leftRandom),
      right.update(delta, inputs, rightRandom),
    );
  }
});

test('invalid dt and input values are safe and signals remain normalized', () => {
  const core = new LifeDynamics();
  const snapshot = core.update(
    Number.POSITIVE_INFINITY,
    {
      ...neutralInputs,
      arousal: Number.NaN,
      curiosity: Number.POSITIVE_INFINITY,
      attention: { viewer: Number.NaN },
      attentionTarget: 'viewer',
      speechUrge: Number.NEGATIVE_INFINITY,
      inhibition: Number.POSITIVE_INFINITY,
      energy: Number.NaN,
      emotion: 42 as unknown as string,
    },
    () => Number.NaN,
  );

  assert.equal(snapshot.modulation.emotion, 'neutral');
  assert.ok(snapshot.life.noise >= -1 && snapshot.life.noise <= 1);
  assert.ok(snapshot.signals.arousal >= 0 && snapshot.signals.arousal <= 1);
  assert.ok(snapshot.signals.curiosity >= 0 && snapshot.signals.curiosity <= 1);
  assert.ok(snapshot.signals.speechUrge >= 0 && snapshot.signals.speechUrge <= 1);
  assert.ok(snapshot.signals.inhibition >= 0 && snapshot.signals.inhibition <= 1);
  assert.equal(snapshot.life.breathingPhase, 0);

  const negativeDeltaSnapshot = core.update(-1, neutralInputs, () => 0.5);
  assert.equal(negativeDeltaSnapshot.life.breathingPhase, 0);
});

test('life phases wrap and injected noise stays bounded', () => {
  const core = new LifeDynamics();
  let snapshot = core.update(0, neutralInputs, () => 1);
  for (let index = 0; index < 200; index += 1) {
    snapshot = core.update(0.1, neutralInputs, () => 1);
  }

  assert.ok(snapshot.life.breathingPhase >= 0);
  assert.ok(snapshot.life.breathingPhase < Math.PI * 2);
  assert.ok(snapshot.life.swayPhase >= 0);
  assert.ok(snapshot.life.swayPhase < Math.PI * 2);
  assert.ok(snapshot.life.noise >= -1 && snapshot.life.noise <= 1);
});

test('orienting moves eyes before head and head before torso', () => {
  const core = new LifeDynamics();
  const snapshot = core.update(
    0.1,
    withAttention('viewer', 1),
    () => 0.5,
  );

  assert.equal(snapshot.orienting.target, 'viewer');
  assert.ok(snapshot.orienting.eyeWeight > snapshot.orienting.headWeight);
  assert.ok(snapshot.orienting.headWeight > snapshot.orienting.torsoWeight);
});

test('released attention returns orienting to neutral', () => {
  const core = new LifeDynamics();
  advance(core, 0.4, withAttention('viewer'), () => 0.5);
  const snapshot = advance(
    core,
    0.6,
    withAttention(null),
    () => 0.5,
  );

  assert.equal(snapshot.orienting.phase, 'neutral');
  assert.equal(snapshot.orienting.target, null);
  assert.equal(snapshot.orienting.eyeWeight, 0);
  assert.equal(snapshot.orienting.headWeight, 0);
  assert.equal(snapshot.orienting.torsoWeight, 0);
});

test('blink progresses through closing, holding, opening, and waiting', () => {
  const core = new LifeDynamics();
  const random = createRandom([0, 0, 0, 0]);
  core.reset(random);

  let snapshot = advance(core, 1.2, neutralInputs, random, 0.05);
  assert.equal(snapshot.blink.phase, 'closing');
  assert.ok(snapshot.blink.weight > 0);

  snapshot = core.update(0.06, neutralInputs, random);
  assert.equal(snapshot.blink.phase, 'holding');
  assert.equal(snapshot.blink.weight, 1);

  snapshot = core.update(0.04, neutralInputs, random);
  assert.equal(snapshot.blink.phase, 'opening');
  assert.ok(snapshot.blink.weight < 1);

  snapshot = core.update(0.1, neutralInputs, random);
  assert.equal(snapshot.blink.phase, 'waiting');
  assert.equal(snapshot.blink.weight, 0);
});

test('attention changes apply a one-time blink hazard boost', () => {
  const control = new LifeDynamics();
  const targetChanged = new LifeDynamics();
  const controlRandom = createRandom([0, 0, 0, 0]);
  const targetRandom = createRandom([0, 0, 0, 0]);
  control.reset(controlRandom);
  targetChanged.reset(targetRandom);

  advance(control, 1.05, neutralInputs, controlRandom);
  advance(targetChanged, 1.05, neutralInputs, targetRandom);

  const controlSnapshot = control.update(0.1, neutralInputs, controlRandom);
  const targetSnapshot = targetChanged.update(
    0.1,
    withAttention('viewer'),
    targetRandom,
  );
  assert.equal(controlSnapshot.blink.state, 'waiting');
  assert.equal(targetSnapshot.blink.state, 'blinking');
});

test('gesture intent advances through onset, sustain, decay, and idle', () => {
  const core = new LifeDynamics();
  const random = () => 0.5;
  const triggered = {
    ...neutralInputs,
    gestureIntent: 'open',
    gestureTrigger: true,
  };
  let snapshot = core.update(0.01, triggered, random);
  assert.equal(snapshot.gesture.intent, 'open');
  assert.equal(snapshot.gesture.phase, 'onset');

  snapshot = advance(
    core,
    0.2,
    { ...neutralInputs, gestureIntent: 'open' },
    random,
  );
  assert.equal(snapshot.gesture.phase, 'sustain');

  snapshot = advance(
    core,
    0.7,
    { ...neutralInputs, gestureIntent: 'open' },
    random,
  );
  assert.equal(snapshot.gesture.phase, 'decay');

  snapshot = advance(core, 0.3, neutralInputs, random);
  assert.equal(snapshot.gesture.phase, 'idle');
  assert.equal(snapshot.gesture.intent, null);
});

test('reset clears phases, noise, history, and transitions', () => {
  const core = new LifeDynamics();
  const random = () => 1;
  core.update(
    0.1,
    {
      ...withAttention('viewer'),
      gestureIntent: 'open',
      gestureTrigger: true,
    },
    random,
  );
  core.reset(random);
  const snapshot = core.update(0, neutralInputs, random);

  assert.equal(snapshot.life.breathingPhase, 0);
  assert.equal(snapshot.life.swayPhase, 0);
  assert.equal(snapshot.life.noise, 0);
  assert.equal(snapshot.blink.phase, 'waiting');
  assert.equal(snapshot.orienting.phase, 'neutral');
  assert.equal(snapshot.orienting.target, null);
  assert.equal(snapshot.gesture.phase, 'idle');
  assert.equal(snapshot.gesture.intent, null);
});

test('snapshots and nested values are immutable', () => {
  const snapshot = new LifeDynamics().update(0.1, neutralInputs, () => 0.5);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.signals), true);
  assert.equal(Object.isFrozen(snapshot.signals.attention), true);
  assert.equal(Object.isFrozen(snapshot.life), true);
  assert.equal(Object.isFrozen(snapshot.orienting), true);
});

test('profiles scale durations and invalid ids use the stable fallback', () => {
  const baseline = createLifeDynamicsProfile('baseline');
  const fast = createLifeDynamicsProfile('0.75x');
  const slow = createLifeDynamicsProfile('1.25x');

  assert.equal(resolveLifeDynamicsProfileId('not-a-profile'), '1.0x');
  assert.equal(resolveLifeDynamicsProfileId(null), '1.0x');
  assert.ok(fast.gazeApproachSeconds < baseline.gazeApproachSeconds);
  assert.ok(slow.gazeApproachSeconds > baseline.gazeApproachSeconds);
  assert.ok(
    Math.abs(fast.gazeApproachSeconds / baseline.gazeApproachSeconds - 0.75) <
      0.000001,
  );
  assert.ok(
    Math.abs(slow.gazeApproachSeconds / baseline.gazeApproachSeconds - 1.25) <
      0.000001,
  );
  assert.equal(createLifeDynamicsProfile('not-a-profile').id, '1.0x');
});
