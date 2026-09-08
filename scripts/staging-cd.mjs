import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCd } from './public-cd.mjs';
export { validateTarget, validateVrm, validateRevision } from './public-cd.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCd(process.argv[2], 'staging').catch(error => { console.error(error.message); process.exitCode = 1; });
}
