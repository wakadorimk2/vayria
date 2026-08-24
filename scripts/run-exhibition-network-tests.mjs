import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(
  process.execPath,
  [
    '--test',
    resolve('node_modules/.tmp/exhibition-network-test/scripts/exhibition-network.test.js'),
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
