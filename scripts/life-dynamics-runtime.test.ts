import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLifeDynamicsRuntimeOptions } from '../src/avatar/lifeDynamicsRuntime.js';

test('LifeDynamics is the default runtime path', () => {
  assert.deepEqual(resolveLifeDynamicsRuntimeOptions(''), {
    enabled: true,
    debug: false,
    profileId: '1.0x',
    gazeProbe: 'full',
  });
});

test('legacy mode restores the previous avatar controllers', () => {
  assert.deepEqual(
    resolveLifeDynamicsRuntimeOptions(
      '?life-dynamics=legacy&life-dynamics-debug=1',
    ),
    {
      enabled: false,
      debug: false,
      profileId: '1.0x',
      gazeProbe: 'full',
    },
  );
});

test('the former PoC URL remains compatible with the default path', () => {
  const options = resolveLifeDynamicsRuntimeOptions(
    '?life-dynamics-poc=1',
  );

  assert.equal(options.enabled, true);
  assert.equal(options.debug, false);
});

test('debug mode preserves profile and gaze probe selection', () => {
  assert.deepEqual(
    resolveLifeDynamicsRuntimeOptions(
      '?life-dynamics-debug=1&life-dynamics-profile=1.25x&gazeProbe=no-neck',
    ),
    {
      enabled: true,
      debug: true,
      profileId: '1.25x',
      gazeProbe: 'no-neck',
    },
  );
  assert.equal(
    resolveLifeDynamicsRuntimeOptions(
      '?life-dynamics-debug=1&life-dynamics-profile=invalid&life-dynamics-gaze-probe=invalid',
    ).profileId,
    '1.0x',
  );
});
