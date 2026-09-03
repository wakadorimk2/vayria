import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFiles = [
  resolve('node_modules/.tmp/performer-test/scripts/card-preview-api.test.js'),
  resolve('node_modules/.tmp/performer-test/scripts/local-api-capture.test.js'),
  resolve(
    'node_modules/.tmp/performer-test/scripts/llm-provider-telemetry.test.js',
  ),
  resolve('node_modules/.tmp/performer-test/scripts/card-reactions.test.js'),
  resolve(
    'node_modules/.tmp/performer-test/scripts/performer-runtime.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/conversation-floor.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/participation-controller.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/character-identity.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/autonomous-context.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/autonomous-talk.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/autonomy-turn-gate.test.js',
  ),
  resolve(
    'node_modules/.tmp/performer-test/scripts/autonomy-state.test.js',
  ),
];
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
