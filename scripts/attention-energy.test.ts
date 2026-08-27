import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTENTION_ENERGY_CONFIG,
  AttentionEnergyController,
  calculateDragEnergyTarget,
} from '../src/attention/attentionEnergyController.js';

test('attention energy starts at the normal baseline', () => {
  const controller = new AttentionEnergyController();

  assert.deepEqual(controller.snapshot(), {
    energy: ATTENTION_ENERGY_CONFIG.normalBaseline,
    active: false,
  });
});

test('each card input adds a bounded impulse and decays toward baseline', () => {
  const controller = new AttentionEnergyController();

  assert.equal(controller.trigger(0).energy, 0.37);
  assert.equal(controller.trigger(0).energy, 0.49);

  const decayed = controller.update(ATTENTION_ENERGY_CONFIG.cardDecayMs);
  assert.ok(decayed.energy > ATTENTION_ENERGY_CONFIG.normalBaseline);
  assert.ok(decayed.energy < 0.49);

  const before = decayed.energy;
  const repeated = controller.trigger(ATTENTION_ENERGY_CONFIG.cardDecayMs, before);
  assert.ok(repeated.energy >= before);
  assert.ok(repeated.energy <= ATTENTION_ENERGY_CONFIG.cardMaximum);
});

test('drag end can carry the last energy without adding a second card impulse', () => {
  const controller = new AttentionEnergyController();

  assert.equal(controller.hold(0, 0.55).energy, 0.55);
  assert.ok(controller.update(100).energy < 0.55);
});

test('drag energy target follows speed without exceeding the configured maximum', () => {
  assert.equal(
    calculateDragEnergyTarget(0),
    ATTENTION_ENERGY_CONFIG.dragBaseline,
  );
  assert.equal(
    calculateDragEnergyTarget(
      ATTENTION_ENERGY_CONFIG.dragSpeedReferencePxPerSecond,
    ),
    ATTENTION_ENERGY_CONFIG.dragMaximum,
  );
  assert.equal(
    calculateDragEnergyTarget(Number.POSITIVE_INFINITY),
    ATTENTION_ENERGY_CONFIG.dragBaseline,
  );
});
