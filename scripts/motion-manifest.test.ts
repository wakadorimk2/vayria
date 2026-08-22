import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MotionManifestError,
  parseMotionManifest,
} from '../src/avatar/motion/motionTypes.js';

const HASH = 'a'.repeat(64);

test('an empty curated motion manifest is valid', () => {
  assert.deepEqual(
    parseMotionManifest({
      schemaVersion: 1,
      avatarSha256: null,
      assets: [],
    }),
    {
      schemaVersion: 1,
      avatarSha256: null,
      assets: [],
    },
  );
});

test('a curated asset preserves its closed tags and provenance', () => {
  const manifest = parseMotionManifest({
    schemaVersion: 1,
    avatarSha256: HASH,
    assets: [
      {
        assetId: 'greeting-small',
        file: 'greeting-small.vrma',
        source: 'saved',
        tags: ['greeting', 'reaction', 'greeting'],
        durationMs: 1200,
        fps: 30,
        loop: false,
        correctionProfileId: 'vayria-default-v1',
        contentSha256: HASH,
      },
    ],
  });

  assert.deepEqual(manifest.assets[0]?.tags, ['greeting', 'reaction']);
  assert.equal(manifest.assets[0]?.source, 'saved');
  assert.equal(manifest.assets[0]?.correctionProfileId, 'vayria-default-v1');
});

test('path traversal and duplicate IDs are rejected', () => {
  assert.throws(
    () =>
      parseMotionManifest({
        schemaVersion: 1,
        assets: [
          {
            assetId: 'unsafe',
            file: '../unsafe.vrma',
            source: 'saved',
            tags: [],
            durationMs: 1000,
            fps: 30,
            loop: false,
            correctionProfileId: 'vayria-default-v1',
            contentSha256: HASH,
          },
        ],
      }),
    MotionManifestError,
  );

  assert.throws(
    () =>
      parseMotionManifest({
        schemaVersion: 1,
        assets: [
          {
            assetId: 'same-id',
            file: 'one.vrma',
            source: 'saved',
            tags: [],
            durationMs: 1000,
            fps: 30,
            loop: false,
            correctionProfileId: 'vayria-default-v1',
            contentSha256: HASH,
          },
          {
            assetId: 'same-id',
            file: 'two.vrma',
            source: 'saved',
            tags: [],
            durationMs: 1000,
            fps: 30,
            loop: false,
            correctionProfileId: 'vayria-default-v1',
            contentSha256: HASH,
          },
        ],
      }),
    /duplicated/,
  );
});
