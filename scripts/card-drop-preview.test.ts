import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCardDropPreview } from '../src/cards/cardDropPreview.js';

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

test('drop preview chooses the nearest replacement card', () => {
  assert.equal(
    resolveCardDropPreview(layout, { x: 175, y: 95 })?.targetCardId,
    'middle',
  );
  assert.equal(
    resolveCardDropPreview(layout, { x: 240, y: 95 })?.targetCardId,
    'right',
  );
});

test('drop preview progresses continuously and caps retreat at 55 percent', () => {
  const approaching = resolveCardDropPreview(layout, { x: 150, y: 100 });
  const centered = resolveCardDropPreview(layout, { x: 150, y: 50 });
  assert.ok(approaching);
  assert.ok(centered);
  assert.ok(approaching.progress > 0 && approaching.progress < 1);
  assert.equal(centered.progress, 1);
  assert.equal(centered.retreatX, 0);
  assert.ok(Math.abs(centered.retreatY + 55) < 0.000_001);
});

test('drop preview retreats away from the incoming card', () => {
  const preview = resolveCardDropPreview(layout, { x: 120, y: 90 });
  assert.ok(preview);
  assert.ok(preview.retreatX > 0);
  assert.ok(preview.retreatY < 0);
});

test('drop preview stays inactive outside the expanded brain lane', () => {
  assert.equal(resolveCardDropPreview(layout, { x: 150, y: 140 }), null);
  assert.equal(resolveCardDropPreview(layout, { x: -40, y: 50 }), null);
});
