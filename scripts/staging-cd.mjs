import { readFile, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const STAGING_URL = 'https://staging.vayria.me';
export function validateTarget(config) {
  if (config.name !== 'vayria-public-staging' || config.account_id !== '7414797104d7aca62f03fbd4faf7e5df' ||
      config.routes?.length !== 1 || config.routes[0].pattern !== 'staging.vayria.me' || config.routes[0].custom_domain !== true ||
      config.vars?.PUBLIC_HOSTNAME !== 'staging.vayria.me' || config.vars?.REQUIRE_PREVIEW_ACCESS !== 'true' ||
      config.workers_dev !== false || config.preview_urls !== false) throw new Error('Deployment target must be the protected staging Worker.');
}
export function validateVrm(bytes, manifest) {
  if (!bytes.length || bytes.length > 25 * 1024 * 1024 || bytes.length !== manifest.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('VRM size or SHA-256 mismatch.');
}
export function validateRevision(event, ref, revision, head, latest) {
  if (event !== 'push' || ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(revision ?? '') || revision !== head || revision !== latest)
    throw new Error('Only the current main commit may deploy.');
}
function run(program, args, capture = false) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(program + ' failed.');
  return result.stdout?.trim() ?? '';
}
async function target() { validateTarget(JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'))); }
async function manifest() {
  const value = JSON.parse(await readFile('deploy/public-vrm.json', 'utf8'));
  if (value.repository !== 'wakadorimk2/vayria-assets' || value.asset !== 'model.vrm' ||
      !/^vrm-[a-f0-9]{12}$/.test(value.tag) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid pinned VRM manifest.');
  return value;
}
async function main(action) {
  if (action === 'fixture') {
    await mkdir('.wrangler', { recursive: true });
    await writeFile('.wrangler/ci-model.vrm', 'CI BUILD FIXTURE - NOT AN AVATAR');
    return;
  }
  await target();
  const pinned = await manifest();
  if (action === 'download') {
    if (!process.env.GH_TOKEN) throw new Error('Private asset read token is required.');
    const repository = JSON.parse(run('gh', ['api', 'repos/' + pinned.repository], true));
    if (repository.private !== true) throw new Error('Asset repository must be private.');
    const directory = resolve('.wrangler/public-vrm');
    await mkdir(directory, { recursive: true });
    await rm(resolve(directory, pinned.asset), { force: true });
    run('gh', ['release', 'download', pinned.tag, '--repo', pinned.repository, '--pattern', pinned.asset, '--dir', directory]);
    validateVrm(await readFile(resolve(directory, pinned.asset)), pinned);
    return;
  }
  if (action === 'guard') {
    validateVrm(await readFile('dist-public/avatar/model.vrm'), pinned);
    const latest = run('gh', ['api', 'repos/wakadorimk2/vayria/git/ref/heads/main', '--jq', '.object.sha'], true);
    validateRevision(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, process.env.GITHUB_SHA,
      run('git', ['rev-parse', 'HEAD'], true), latest);
    return;
  }
  if (action === 'deploy') {
    await main('guard');
    const result = run(process.execPath, ['node_modules/wrangler/wrangler-dist/cli.js', 'deploy', '--config', 'wrangler.public.jsonc', '--env-file', 'deploy/placeholder.env'], true);
    // Wrangler output contains deployment metadata only; never print environment values.
    const version = result.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
    if (!version) throw new Error('Deployment returned no Worker Version ID. Inspect Cloudflare before retrying.');
    const summary = 'Staging deployed\n\nCommit: ' + process.env.GITHUB_SHA + '\n\nWorker Version: ' + version + '\n\nURL: ' + STAGING_URL + '\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  if (action === 'smoke') {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const page = await fetch(STAGING_URL, { signal: AbortSignal.timeout(10000) });
        const api = await fetch(STAGING_URL + '/api/session', { signal: AbortSignal.timeout(10000) });
        if (page.status !== 401 || !(await page.text()).includes('検証用アクセスチケット') ||
            api.status !== 403 || (await api.json()).code !== 'preview_access_required') throw new Error('Staging access gate check failed.');
        console.log('Staging smoke passed: root 401; session 403. No generation requests.');
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(done => setTimeout(done, 5000));
      }
    }
  }
  else throw new Error('Expected fixture, download, guard, deploy, or smoke.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
