import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_DRAG_VISUAL_LIFT_PX,
  resolveCardDragPlacement,
  resolveCommittedCardDropTarget,
  resolveCardDropPreview,
} from '../src/cards/cardDropPreview.js';

const layout = {
  left: 0,
  right: 300,
  top: 100,
  bottom: 200,
  cards: [
    { id: 'left', centerX: 50, centerY: 150, width: 80, height: 100 },
    { id: 'middle', centerX: 150, centerY: 150, width: 80, height: 100 },
    { id: 'right', centerX: 250, centerY: 150, width: 80, height: 100 },
  ],
} as const;

function pointer(pointerX: number, pointerY = 150) {
  return { pointerX, pointerY };
}

test('pointer X selects the nearest card including gaps and outer edges', () => {
  assert.equal(resolveCardDropPreview(layout, pointer(50))?.targetCardId, 'left');
  assert.equal(resolveCardDropPreview(layout, pointer(105))?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(-200))?.targetCardId, 'left');
  assert.equal(resolveCardDropPreview(layout, pointer(500))?.targetCardId, 'right');
});

test('target selection depends on pointer position rather than drag grab offset', () => {
  const leftGrab = resolveCardDragPlacement({
    ...pointer(150),
    height: 100,
    offsetX: 8,
    offsetY: 50,
    width: 80,
  });
  const rightGrab = resolveCardDragPlacement({
    ...pointer(150),
    height: 100,
    offsetX: 72,
    offsetY: 50,
    width: 80,
  });
  assert.notEqual(leftGrab.left, rightGrab.left);
  assert.equal(resolveCardDropPreview(layout, pointer(150))?.targetCardId, 'middle');
});

test('unlocked target activates only inside the actual lane bounds', () => {
  assert.equal(resolveCardDropPreview(layout, pointer(150, 99)), null);
  assert.equal(resolveCardDropPreview(layout, pointer(150, 100))?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(150, 200))?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(150, 201)), null);
});

test('locked target retains through the 24 pixel vertical exit margin', () => {
  assert.equal(resolveCardDropPreview(layout, pointer(150, 76), 'middle')?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(150, 224), 'middle')?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(150, 75), 'middle'), null);
  assert.equal(resolveCardDropPreview(layout, pointer(150, 225), 'middle'), null);
});

test('locked target requires 15 percent travel beyond the midpoint to retarget', () => {
  assert.equal(resolveCardDropPreview(layout, pointer(214), 'middle')?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(215), 'middle')?.targetCardId, 'right');
  assert.equal(resolveCardDropPreview(layout, pointer(86), 'middle')?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, pointer(85), 'middle')?.targetCardId, 'left');
});

test('target retreats up by 60 percent within the 60 to 100 pixel cap', () => {
  const minimum = resolveCardDropPreview(layout, pointer(150));
  const tallLayout = {
    ...layout,
    bottom: 400,
    cards: [
      { id: 'tall', centerX: 150, centerY: 200, width: 80, height: 300 },
    ],
  } as const;
  const maximum = resolveCardDropPreview(tallLayout, pointer(150, 200));
  assert.equal(minimum?.retreatY, -60);
  assert.equal(minimum?.scale, 0.94);
  assert.equal(Math.abs(minimum?.rotationDeg ?? 0), 2);
  assert.equal(maximum?.retreatY, -100);
});

test('drag placement and spatial center share the fixed 32 pixel lift', () => {
  const placement = resolveCardDragPlacement({
    ...pointer(150, 300),
    height: 100,
    offsetX: 20,
    offsetY: 40,
    width: 80,
  });
  assert.equal(CARD_DRAG_VISUAL_LIFT_PX, 32);
  assert.deepEqual(placement, {
    left: 130,
    top: 228,
    centerX: 170,
    centerY: 278,
  });
});

test('drop commit requires the same target shown by the preview', () => {
  const middle = resolveCardDropPreview(layout, pointer(150));
  const right = resolveCardDropPreview(layout, pointer(250));
  assert.equal(resolveCommittedCardDropTarget(middle, right), null);
  assert.equal(resolveCommittedCardDropTarget(middle, null), null);
  assert.equal(resolveCommittedCardDropTarget(middle, middle), 'middle');
});
