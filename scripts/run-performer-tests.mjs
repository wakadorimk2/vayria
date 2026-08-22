import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFiles = [
  resolve('node_modules/.tmp/performer-test/scripts/card-preview-api.test.js'),
  resolve('node_modules/.tmp/performer-test/scripts/local-api-capture.test.js'),
  resolve('node_modules/.tmp/performer-test/scripts/card-reactions.test.js'),
  resolve(
    'node_modules/.tmp/performer-test/scripts/performer-runtime.test.js',
  ),
];
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
