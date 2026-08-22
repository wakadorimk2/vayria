import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFile = resolve(
  'node_modules/.tmp/avatar-test/scripts/idle-gaze.test.js',
);
const result = spawnSync(process.execPath, ['--test', testFile], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
