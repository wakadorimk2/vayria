import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWithinExpressionBudget,
  resolveExpressionBudget,
} from '../src/conversation/utterancePlan.js';

test('expression budget stays low for ordinary autonomous speech', () => {
  assert.equal(
    resolveExpressionBudget({
      mode: 'autonomous',
      forcedCardEnergy: null,
      recentExpressionLevels: [],
    }),
    'low',
  );
});

test('high-energy forced cards allow high expression after cooldown', () => {
  assert.equal(
    resolveExpressionBudget({
      mode: 'manual',
      forcedCardEnergy: 'high',
      recentExpressionLevels: Array(10).fill('low'),
    }),
    'high',
  );
  assert.equal(
    resolveExpressionBudget({
      mode: 'voice',
      forcedCardEnergy: 'high',
      recentExpressionLevels: ['high'],
    }),
    'medium',
  );
});

test('expression levels cannot exceed the runtime budget', () => {
  assert.equal(isWithinExpressionBudget('low', 'low'), true);
  assert.equal(isWithinExpressionBudget('medium', 'low'), false);
  assert.equal(isWithinExpressionBudget('high', 'medium'), false);
});
