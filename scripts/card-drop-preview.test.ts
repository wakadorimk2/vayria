import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measureCardOverlapRatio,
  resolveCommittedCardDropTarget,
  resolveCardDropPreview,
  type CardDropPreviewInput,
} from '../src/cards/cardDropPreview.js';

const layout = {
  left: 0,
  right: 300,
  top: 0,
  bottom: 100,
  cards: [
    { id: 'left', centerX: 50, centerY: 50, width: 80, height: 100 },
    { id: 'middle', centerX: 150, centerY: 50, width: 80, height: 100 },
    { id: 'right', centerX: 250, centerY: 50, width: 80, height: 100 },
  ],
} as const;

function dragInput(
  left: number,
  top: number,
  overrides: Partial<CardDropPreviewInput> = {},
): CardDropPreviewInput {
  return {
    height: 100,
    left,
    top,
    width: 80,
    ...overrides,
  };
}

test('drop preview measures overlap against the target card area', () => {
  const middle = layout.cards[1];
  assert.equal(
    measureCardOverlapRatio(middle, {
      left: 110,
      right: 190,
      top: 0,
      bottom: 100,
    }),
    1,
  );
  assert.equal(
    measureCardOverlapRatio(middle, {
      left: 110,
      right: 190,
      top: 75,
      bottom: 175,
    }),
    0.25,
  );
});

test('drop preview stays a candidate below 0.35 overlap and locks at the threshold', () => {
  const candidate = resolveCardDropPreview(layout, dragInput(110, 66));
  const locked = resolveCardDropPreview(layout, dragInput(110, 65));
  assert.equal(candidate?.targetCardId, 'middle');
  assert.equal(candidate?.phase, 'candidate');
  assert.equal(candidate?.retreatY, 0);
  assert.equal(locked?.targetCardId, 'middle');
  assert.equal(locked?.phase, 'locked');
  assert.equal(locked?.overlapRatio, 0.35);
});

test('locked target unlocks below 0.20 overlap', () => {
  const retained = resolveCardDropPreview(
    layout,
    dragInput(110, 80),
    'middle',
  );
  const unlocked = resolveCardDropPreview(
    layout,
    dragInput(110, 81),
    'middle',
  );
  assert.equal(retained?.phase, 'locked');
  assert.equal(retained?.targetCardId, 'middle');
  assert.equal(unlocked?.phase, 'candidate');
});

test('locked target requires a 0.15 advantage before retargeting', () => {
  const stable = resolveCardDropPreview(layout, dragInput(64, 0), 'left');
  const retargeted = resolveCardDropPreview(layout, dragInput(68, 0), 'left');
  assert.equal(stable?.targetCardId, 'left');
  assert.equal(stable?.phase, 'locked');
  assert.equal(retargeted?.targetCardId, 'middle');
  assert.equal(retargeted?.phase, 'locked');
});

test('locked target retreats up by 24 percent within the 24 to 40 pixel cap', () => {
  const minimum = resolveCardDropPreview(layout, dragInput(110, 0));
  const tallLayout = {
    ...layout,
    bottom: 300,
    cards: [
      {
        id: 'tall',
        centerX: 150,
        centerY: 150,
        width: 80,
        height: 300,
      },
    ],
  } as const;
  const maximum = resolveCardDropPreview(tallLayout, {
    ...dragInput(110, 0),
    height: 300,
  });
  assert.equal(minimum?.retreatY, -24);
  assert.equal(minimum?.scale, 0.94);
  assert.equal(Math.abs(minimum?.rotationDeg ?? 0), 2);
  assert.equal(maximum?.retreatY, -40);
});

test('preview remains inactive without any card overlap', () => {
  assert.equal(resolveCardDropPreview(layout, dragInput(110, 101)), null);
  assert.equal(resolveCardDropPreview(layout, dragInput(-100, 0)), null);
});

test('drop commit requires the same locked target shown by the preview', () => {
  const candidate = resolveCardDropPreview(layout, dragInput(110, 66));
  const lockedMiddle = resolveCardDropPreview(layout, dragInput(110, 0));
  const lockedRight = resolveCardDropPreview(layout, dragInput(210, 0));
  assert.equal(
    resolveCommittedCardDropTarget(candidate, lockedMiddle),
    null,
  );
  assert.equal(
    resolveCommittedCardDropTarget(lockedMiddle, lockedRight),
    null,
  );
  assert.equal(
    resolveCommittedCardDropTarget(lockedMiddle, lockedMiddle),
    'middle',
  );
});
