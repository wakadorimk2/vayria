import { runCd } from './public-cd.mjs';

runCd(process.argv[2], 'production').catch(error => { console.error(error.message); process.exitCode = 1; });
