import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const child = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js')], {
  stdio: 'inherit',
  env: { ...process.env, VITE_APP_MODE: 'local', VITE_WORLD_MUTATION_ENABLED: 'true' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
