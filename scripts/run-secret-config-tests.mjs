import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const testFile = resolve(
  'node_modules/.tmp/secret-config-test/scripts/secret-config.test.js',
);
const result = spawnSync(process.execPath, ['--test', testFile], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
