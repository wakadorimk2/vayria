import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFiles = [
  resolve(
    'node_modules/.tmp/avatar-test/scripts/camera-attention-controller.test.js',
  ),
  resolve('node_modules/.tmp/avatar-test/scripts/camera-tracking.test.js'),
  resolve('node_modules/.tmp/avatar-test/scripts/attention-state.test.js'),
  resolve(
    'node_modules/.tmp/avatar-test/scripts/attention-engagement.test.js',
  ),
  resolve('node_modules/.tmp/avatar-test/scripts/attention-target.test.js'),
  resolve('node_modules/.tmp/avatar-test/scripts/idle-gaze.test.js'),
  resolve('node_modules/.tmp/avatar-test/scripts/life-dynamics.test.js'),
  resolve(
    'node_modules/.tmp/avatar-test/scripts/life-dynamics-life-adapter.test.js',
  ),
  resolve(
    'node_modules/.tmp/avatar-test/scripts/life-dynamics-orienting-adapter.test.js',
  ),
];
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
