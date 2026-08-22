import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFiles = [
  resolve('node_modules/.tmp/motion-test/scripts/card-motion-assets.test.js'),
  resolve('node_modules/.tmp/motion-test/scripts/motion-player.test.js'),
  resolve('node_modules/.tmp/motion-test/scripts/motion-manifest.test.js'),
];
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
