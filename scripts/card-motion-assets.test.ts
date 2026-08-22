import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  attachCardPreviewMotion,
  CARD_MOTION_ASSET_IDS,
} from '../src/cards/cardMotionAssets.js';
import { cardPool } from '../src/cards/cardPool.js';
import { parseMotionManifest } from '../src/avatar/motion/motionTypes.js';
import type { PerformancePlan } from '../src/performer/types.js';

const repositoryRoot = path.resolve('.');
const manifestPath = path.join(
  repositoryRoot,
  'public/avatar/motions/manifest.json',
);

function createPlan(): PerformancePlan {
  return {
    planId: 'test-plan',
    trigger: 'external_stimulus',
    intent: 'speak',
    activeDirectionIds: [],
  };
}

test('every Card Pool card has one saved VRMA asset', () => {
  const manifest = parseMotionManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  const cardIds = cardPool.map((card) => card.id);
  const assetIds = manifest.assets.map((asset) => asset.assetId);

  assert.equal(manifest.assets.length, 18);
  assert.equal(new Set(assetIds).size, 18);
  assert.deepEqual(
    assetIds,
    cardIds.map((cardId) => CARD_MOTION_ASSET_IDS[cardId]),
  );

  for (const asset of manifest.assets) {
    const filePath = path.join(
      repositoryRoot,
      'public/avatar/motions',
      asset.file,
    );
    assert.equal(fs.existsSync(filePath), true, asset.file);
    const contentSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
    assert.equal(contentSha256, asset.contentSha256, asset.assetId);
    assert.equal(asset.source, 'saved');
    assert.deepEqual(asset.tags, ['reaction']);
    assert.equal(asset.loop, false);
    assert.equal(asset.fps, 50);
  }
});

test('Card Pool preview adds a saved motion asset unless motion is reduced', () => {
  const plan = createPlan();
  assert.equal(
    attachCardPreviewMotion(plan, 'chicken', false).motion?.assetId,
    'card-chicken',
  );
  assert.equal(attachCardPreviewMotion(plan, 'chicken', true).motion, undefined);
});
