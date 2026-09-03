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

function previewInput(pointerX: number, dragTop: number, height = 100) {
  return {
    dragBottom: dragTop + height,
    dragTop,
    pointerX,
  };
}

test('pointer X selects the nearest card including gaps and outer edges', () => {
  assert.equal(resolveCardDropPreview(layout, previewInput(50, 224))?.targetCardId, 'left');
  assert.equal(resolveCardDropPreview(layout, previewInput(105, 224))?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, previewInput(-200, 224))?.targetCardId, 'left');
  assert.equal(resolveCardDropPreview(layout, previewInput(500, 224))?.targetCardId, 'right');
});

test('candidate starts 24 pixels before the visible card reaches the lane', () => {
  assert.equal(resolveCardDropPreview(layout, previewInput(150, 225)), null);
  const candidate = resolveCardDropPreview(layout, previewInput(150, 224));
  assert.equal(candidate?.phase, 'candidate');
  assert.equal(candidate?.targetCardId, 'middle');
  assert.equal(candidate?.retreatY, 0);
  assert.equal(candidate?.scale, 1);
  assert.equal(candidate?.rotationDeg, 0);
});

test('candidate retreat follows approach and insertion depth continuously', () => {
  const twelvePixelsAway = resolveCardDropPreview(
    layout,
    previewInput(150, 212),
  );
  const touching = resolveCardDropPreview(layout, previewInput(150, 200));
  const sixPixelsInserted = resolveCardDropPreview(
    layout,
    previewInput(150, 194),
  );
  const almostLocked = resolveCardDropPreview(
    layout,
    previewInput(150, 188.1),
  );
  assert.equal(twelvePixelsAway?.retreatY, -2);
  assert.equal(touching?.retreatY, -4);
  assert.equal(sixPixelsInserted?.retreatY, -16);
  assert.ok((almostLocked?.retreatY ?? 0) < -27.7);
  assert.ok((almostLocked?.retreatY ?? -100) > -28);
});

test('visible card locks after 12 pixels of lane overlap', () => {
  const candidate = resolveCardDropPreview(layout, previewInput(150, 189));
  const locked = resolveCardDropPreview(layout, previewInput(150, 188));
  assert.equal(candidate?.phase, 'candidate');
  assert.equal(locked?.phase, 'locked');
});

test('locked preview retains through 8 pixels and returns to candidate below it', () => {
  const locked = resolveCardDropPreview(layout, previewInput(150, 188));
  const retained = resolveCardDropPreview(layout, previewInput(150, 192), locked);
  const released = resolveCardDropPreview(layout, previewInput(150, 193), retained);
  assert.equal(retained?.phase, 'locked');
  assert.equal(released?.phase, 'candidate');
  assert.equal(released?.retreatY, -18);
});

test('target selection uses pointer X while phase uses the visible card top', () => {
  const shallowGrab = resolveCardDragPlacement({
    height: 100,
    offsetX: 8,
    offsetY: 20,
    pointerX: 150,
    pointerY: 240,
    width: 80,
  });
  const deepGrab = resolveCardDragPlacement({
    height: 100,
    offsetX: 72,
    offsetY: 70,
    pointerX: 150,
    pointerY: 290,
    width: 80,
  });
  assert.equal(shallowGrab.top, 188);
  assert.equal(deepGrab.top, 188);
  assert.notEqual(shallowGrab.left, deepGrab.left);
  assert.equal(resolveCardDropPreview(layout, previewInput(150, shallowGrab.top))?.phase, 'locked');
  assert.equal(resolveCardDropPreview(layout, previewInput(150, deepGrab.top))?.phase, 'locked');
});

test('locked target requires 15 percent travel beyond the midpoint to retarget', () => {
  const middle = resolveCardDropPreview(layout, previewInput(150, 188));
  assert.equal(resolveCardDropPreview(layout, previewInput(214, 188), middle)?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, previewInput(215, 188), middle)?.targetCardId, 'right');
  assert.equal(resolveCardDropPreview(layout, previewInput(86, 188), middle)?.targetCardId, 'middle');
  assert.equal(resolveCardDropPreview(layout, previewInput(85, 188), middle)?.targetCardId, 'left');
});

test('locked target retreats up by 60 percent within the 60 to 100 pixel cap', () => {
  const minimum = resolveCardDropPreview(layout, previewInput(150, 188));
  const tallLayout = {
    ...layout,
    bottom: 400,
    cards: [
      { id: 'tall', centerX: 150, centerY: 250, width: 80, height: 300 },
    ],
  } as const;
  const maximum = resolveCardDropPreview(tallLayout, previewInput(150, 388, 300));
  assert.equal(minimum?.retreatY, -60);
  assert.equal(minimum?.scale, 0.94);
  assert.equal(Math.abs(minimum?.rotationDeg ?? 0), 2);
  assert.equal(maximum?.retreatY, -100);
});

test('drag placement and spatial center share the fixed 32 pixel lift', () => {
  const placement = resolveCardDragPlacement({
    height: 100,
    offsetX: 20,
    offsetY: 40,
    pointerX: 150,
    pointerY: 300,
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

test('drop commit requires matching locked previews', () => {
  const candidate = resolveCardDropPreview(layout, previewInput(150, 224));
  const middle = resolveCardDropPreview(layout, previewInput(150, 188));
  const right = resolveCardDropPreview(layout, previewInput(250, 188));
  assert.equal(resolveCommittedCardDropTarget(candidate, candidate), null);
  assert.equal(resolveCommittedCardDropTarget(middle, candidate), null);
  assert.equal(resolveCommittedCardDropTarget(middle, right), null);
  assert.equal(resolveCommittedCardDropTarget(middle, middle), 'middle');
});
