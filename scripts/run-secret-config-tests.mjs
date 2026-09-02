import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFiles = [
  resolve('node_modules/.tmp/secret-config-test/scripts/secret-config.test.js'),
  resolve('node_modules/.tmp/secret-config-test/scripts/aivis-cloud.test.js'),
];
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
