import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  attachCardPreviewMotion,
  CARD_MOTION_ASSET_BY_GESTURE_INTENT,
  CARD_MOTION_ASSET_IDS,
} from '../src/cards/cardMotionAssets.js';
import { cardPool } from '../src/cards/cardPool.js';
import { CARD_REACTION_PROFILES } from '../src/cards/cardReactions.js';
import { parseMotionManifest } from '../src/avatar/motion/motionTypes.js';
import { resolveMotionPlaybackProfile } from '../src/avatar/motion/motionCorrection.js';
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
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 1200,
      postSpeechHoldMs: 250,
    },
    activeDirectionIds: [],
  };
}

test('every Card Pool card has one saved VRMA asset', () => {
  const manifest = parseMotionManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  const cardAssets = manifest.assets.filter((asset) =>
    asset.assetId.startsWith('card-'),
  );
  const cardIds = cardPool.map((card) => card.id);
  const assetIds = cardAssets.map((asset) => asset.assetId);

  assert.equal(manifest.assets.length, 20);
  assert.equal(cardAssets.length, 18);
  assert.equal(new Set(assetIds).size, 18);
  assert.deepEqual(
    assetIds,
    cardIds.map((cardId) => CARD_MOTION_ASSET_IDS[cardId]),
  );

  for (const asset of cardAssets) {
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
    assert.equal(
      resolveMotionPlaybackProfile(asset.correctionProfileId).profileId,
      'vayria-default-v1',
    );
  }
});

test('ordinary speech has one separate gentle motion asset', () => {
  const manifest = parseMotionManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  const asset = manifest.assets.find(
    (candidate) => candidate.assetId === 'speech-gentle',
  );
  assert.ok(asset);
  assert.equal(asset.file, 'speech-gentle.vrma');
  assert.deepEqual(asset.tags, ['idle']);
  assert.equal(asset.durationMs, 3950);
  assert.equal(asset.fps, 50);
  assert.equal(asset.loop, false);
  assert.equal(asset.correctionProfileId, 'vayria-default-v1');
  assert.equal(
    asset.contentSha256,
    '3b3c9c886d4a57337bede1aa0698eff6dcaa82c9b2fecf4c7dee38d091d7edc7',
  );
  const filePath = path.join(
    repositoryRoot,
    'public/avatar/motions',
    asset.file,
  );
  assert.equal(fs.existsSync(filePath), true);
  const contentSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
  assert.equal(contentSha256, asset.contentSha256);
  assert.equal(
    resolveMotionPlaybackProfile(asset.correctionProfileId).profileId,
    'vayria-default-v1',
  );
});

test('voice listener reaction uses a three-second saved VRMA asset', () => {
  const manifest = parseMotionManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  const asset = manifest.assets.find(
    (candidate) => candidate.assetId === 'listening-thinking',
  );
  assert.ok(asset);
  assert.equal(asset.file, 'listening-thinking.vrma');
  assert.deepEqual(asset.tags, ['reaction']);
  assert.equal(asset.durationMs, 3000);
  assert.equal(asset.fps, 20);
  assert.equal(asset.loop, false);
  assert.equal(asset.correctionProfileId, 'vayria-default-v1');
  const filePath = path.join(
    repositoryRoot,
    'public/avatar/motions',
    asset.file,
  );
  assert.equal(fs.existsSync(filePath), true);
  const contentSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
  assert.equal(contentSha256, asset.contentSha256);
});

test('Card Pool preview adds a saved motion asset unless motion is reduced', () => {
  const plan = createPlan();
  for (const card of cardPool) {
    const profile = CARD_REACTION_PROFILES[card.id];
    const withMotion = attachCardPreviewMotion(plan, card.id, false);
    const reduced = attachCardPreviewMotion(plan, card.id, true);

    assert.deepEqual(withMotion.behavior, profile.behavior, card.id);
    assert.equal(
      withMotion.motion?.assetId,
      CARD_MOTION_ASSET_BY_GESTURE_INTENT[profile.behavior.gestureIntent],
    );
    assert.equal(
      CARD_MOTION_ASSET_BY_GESTURE_INTENT[profile.behavior.gestureIntent],
      CARD_MOTION_ASSET_IDS[card.id],
    );
    assert.deepEqual(reduced.behavior, profile.behavior, card.id);
    assert.equal(reduced.motion, undefined, card.id);
  }
});
