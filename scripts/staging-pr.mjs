import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTarget, validateVrm, runCd } from './public-cd.mjs';

export function validatePr(pr, sha, head, dirty) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || sha !== head || pr.head?.sha !== sha || pr.state !== 'open' ||
      pr.head?.repo?.full_name !== 'wakadorimk2/vayria' || pr.base?.repo?.full_name !== 'wakadorimk2/vayria' ||
      pr.base?.ref !== 'main' || dirty.trim()) throw new Error('Deploy requires a clean checkout of the current open same-repository PR SHA.');
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.slice(-2000) ?? ''}`);
  return result.stdout.trim();
}
export async function deployPr(number, sha) {
  if (!/^\d+$/.test(number ?? '')) throw new Error('Usage: node scripts/staging-pr.mjs PR SHA');
  const config = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8')); validateTarget(config);
  if (config.main !== 'worker/index.ts' || config.assets?.directory !== 'dist-public') throw new Error('Unexpected staging entrypoint');
  const guard = () => validatePr(JSON.parse(run('gh', ['api', `repos/wakadorimk2/vayria/pulls/${number}`])), sha,
    run('git', ['rev-parse', 'HEAD']), run('git', ['status', '--porcelain']));
  guard();
  const cli = ['node_modules/wrangler/wrangler-dist/cli.js'];
  const env = { ...process.env, VAYRIA_STAGING_MANIFESTATION: 'true' };
  const npm = ['node_modules/npm/bin/npm-cli.js'];
  // Use npm's installed executable through the shell only on Windows; arguments are fixed.
  const check = task => {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', task], { encoding: 'utf8', windowsHide: true, env, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${task} failed: ${(result.stdout + result.stderr).slice(-3000)}`);
  };
  void npm;
  for (const task of ['typecheck', 'lint', 'test:public', 'test:cd', 'public:build', 'public:check']) check(task);
  validateVrm(await readFile('dist-public/avatar/model.vrm'), JSON.parse(await readFile('deploy/public-vrm.json', 'utf8')));
  guard();
  const previous = run(process.execPath, [...cli, 'deployments', 'list', '--config', 'wrangler.public.jsonc', '--env-file', 'deploy/placeholder.env', '--json']);
  await mkdir('.wrangler', { recursive: true });
  await writeFile('.wrangler/staging-pr-previous.json', previous);
  guard();
  const result = run(process.execPath, [...cli, 'deploy', '--config', 'wrangler.public.jsonc', '--env-file', 'deploy/placeholder.env', '--var', 'MANIFESTATION_ENABLED:true']);
  const version = result.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
  if (!version) throw new Error('Deployment may be live but returned no version. Inspect Cloudflare; do not retry blindly.');
  await writeFile('.wrangler/staging-pr-deployment.json', JSON.stringify({ pr: Number(number), sha, version, url: 'https://staging.vayria.me', at: new Date().toISOString() }));
  console.log(`Staging PR #${number}: ${sha}\nWorker: ${version}\nhttps://staging.vayria.me`);
  await runCd('smoke');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployPr(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
