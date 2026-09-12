import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result = spawnSync(process.execPath, ['--test', resolve('node_modules/.tmp/world-test/scripts/world-mutation.test.js'), resolve('node_modules/.tmp/world-test/scripts/world-api.test.js'), resolve('node_modules/.tmp/world-test/scripts/world-presentation.test.js')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
