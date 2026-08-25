import assert from 'node:assert/strict';
import test from 'node:test';
import type { VRM } from '@pixiv/three-vrm';
import {
  LifeDynamics,
  type LifeDynamicsInputs,
  type LifeDynamicsSnapshot,
} from '../src/avatar/lifeDynamics.js';
import { LifeDynamicsBlinkAdapter } from '../src/avatar/lifeDynamicsBlinkAdapter.js';

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

function createFakeVrm(expressionNames: readonly string[]): {
  values: Map<string, number>;
  vrm: VRM;
} {
  const values = new Map<string, number>();
  const available = new Set(expressionNames);
  const expressionManager = {
    getExpression(name: string) {
      return available.has(name) ? {} : undefined;
    },
    setValue(name: string, value: number) {
      values.set(name, value);
    },
  };

  return {
    values,
    vrm: { expressionManager } as unknown as VRM,
  };
}

function createSnapshot(weight: number): LifeDynamicsSnapshot {
  const snapshot = new LifeDynamics().update(0, neutralInputs, () => 0.5);
  return {
    ...snapshot,
    blink: {
      ...snapshot.blink,
      weight,
    },
  };
}

test('blink preset takes priority over left and right expressions', () => {
  const { values, vrm } = createFakeVrm([
    'blink',
    'blinkLeft',
    'blinkRight',
  ]);
  const adapter = new LifeDynamicsBlinkAdapter(vrm);

  adapter.apply(createSnapshot(0.4));

  assert.deepEqual([...values.entries()], [['blink', 0.4]]);
});

test('paired left and right expressions receive the same weight', () => {
  const { values, vrm } = createFakeVrm(['blinkLeft', 'blinkRight']);
  const adapter = new LifeDynamicsBlinkAdapter(vrm);

  adapter.apply(createSnapshot(0.65));

  assert.deepEqual(
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [
      ['blinkLeft', 0.65],
      ['blinkRight', 0.65],
    ],
  );
});

test('missing blink expressions are a safe no-op', () => {
  const { values, vrm } = createFakeVrm([]);
  const adapter = new LifeDynamicsBlinkAdapter(vrm);

  assert.doesNotThrow(() => adapter.apply(createSnapshot(0.5)));
  assert.equal(values.size, 0);
});

test('weight is clamped and reset clears the absolute output', () => {
  const { values, vrm } = createFakeVrm(['blink']);
  const adapter = new LifeDynamicsBlinkAdapter(vrm);

  adapter.apply(createSnapshot(2));
  assert.equal(values.get('blink'), 1);

  adapter.apply(createSnapshot(Number.NaN));
  assert.equal(values.get('blink'), 0);

  adapter.apply(createSnapshot(0.8));
  adapter.apply(createSnapshot(0.8));
  assert.equal(values.get('blink'), 0.8);

  adapter.reset();
  assert.equal(values.get('blink'), 0);

  adapter.apply(createSnapshot(0.7));
  adapter.dispose();
  assert.equal(values.get('blink'), 0);
});
