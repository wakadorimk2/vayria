import { readFile, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const STAGING_URL = 'https://staging.vayria.me';
export const PRODUCTION_URL = 'https://vayria.me';
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
  if (!['push', 'workflow_dispatch'].includes(event) || ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(revision ?? '') || revision !== head || revision !== latest)
    throw new Error('Only the current main commit may deploy.');
}
export function validateProductionTarget(config) {
  if (config.name !== 'vayria-web' || config.account_id !== '7414797104d7aca62f03fbd4faf7e5df' ||
      config.main !== 'worker/index.ts' || config.routes?.length !== 1 ||
      config.routes[0].pattern !== 'vayria.me' || config.routes[0].custom_domain !== true ||
      config.vars?.PUBLIC_HOSTNAME !== 'vayria.me' || config.vars?.REQUIRE_PREVIEW_ACCESS !== 'false' ||
      config.vars?.GENERATION_ENABLED !== 'true' || config.vars?.SERVE_PLACEHOLDER === 'true' ||
      config.vars?.TURNSTILE_SITE_KEY !== '0x4AAAAAAErpgvhBvYpnRm71' ||
      config.workers_dev !== false || config.preview_urls !== false ||
      config.assets?.directory !== 'dist-public' || config.assets?.binding !== 'ASSETS' ||
      config.assets?.run_worker_first !== true || config.assets?.not_found_handling !== 'none' ||
      JSON.stringify(config.durable_objects) !== JSON.stringify({ bindings: [{ name: 'USAGE', class_name: 'PublicUsage' }] }) ||
      JSON.stringify(config.migrations) !== JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['PublicUsage'] }]))
    throw new Error('Deployment target must be the public production Worker with the existing ledger.');
}
export function validateProductionActivation(enabled, stagingResult) {
  if (enabled !== 'true' || stagingResult !== 'success') throw new Error('Production CD must be enabled and staging must succeed.');
}

// GET only: verify the deployed build and Cookie bootstrap without starting a paid session.
export async function productionSmoke(fetchImpl, pinned, expectedHtml, expectedScriptBytes) {
  const get = (path, headers) => fetchImpl(PRODUCTION_URL + path, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const page = await get('/');
  const html = await page.text();
  const scriptPath = expectedHtml.match(/src="(\/assets\/[A-Za-z0-9_.-]+\.js)"/)?.[1];
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html') || !scriptPath ||
      html !== expectedHtml || !html.includes('id="root"')) throw new Error('Production page does not match the build.');
  const script = await get(scriptPath);
  if (!script.ok || !Buffer.from(await script.arrayBuffer()).equals(expectedScriptBytes)) throw new Error('Production script does not match the build.');
  const vrm = await get('/avatar/model.vrm');
  if (!vrm.ok) throw new Error('Production avatar is unavailable.');
  validateVrm(Buffer.from(await vrm.arrayBuffer()), pinned);
  const bootstrap = await get('/api/session');
  if (!bootstrap.ok) throw new Error('Production Cookie bootstrap failed.');
  const first = await bootstrap.json();
  const setCookie = bootstrap.headers.get('set-cookie') ?? '';
  if (first.cookieReady !== false || !/^__Host-vayria=/.test(setCookie) ||
      !/;\s*Secure(?:;|$)/i.test(setCookie) || !/;\s*HttpOnly(?:;|$)/i.test(setCookie) ||
      !/;\s*SameSite=Strict(?:;|$)/i.test(setCookie) || !/;\s*Path=\/(?:;|$)/i.test(setCookie))
    throw new Error('Production Cookie attributes are invalid.');
  const resumed = await get('/api/session', { Cookie: setCookie.split(';')[0] });
  if (!resumed.ok) throw new Error('Production session status failed.');
  const status = await resumed.json();
  if (status.cookieReady !== true || status.enabled !== true || status.stopped !== false ||
      status.siteKey !== '0x4AAAAAAErpgvhBvYpnRm71' || status.session != null)
    throw new Error('Production generation or session configuration is not ready.');
}

function run(program, args, capture = false) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(program + ' failed.');
  return result.stdout?.trim() ?? '';
}
async function manifest() {
  const value = JSON.parse(await readFile('deploy/public-vrm.json', 'utf8'));
  if (value.repository !== 'wakadorimk2/vayria-assets' || value.asset !== 'model.vrm' ||
      !/^vrm-[a-f0-9]{12}$/.test(value.tag) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid pinned VRM manifest.');
  return value;
}
export async function runCd(action, environment = 'staging') {
  if (!['staging', 'production'].includes(environment)) throw new Error('Unknown deployment environment.');
  const production = environment === 'production';
  const configPath = production ? 'wrangler.production.jsonc' : 'wrangler.public.jsonc';
  const label = production ? 'Production' : 'Staging';
  const url = production ? PRODUCTION_URL : STAGING_URL;
  if (action === 'fixture') {
    await mkdir('.wrangler', { recursive: true });
    await writeFile('.wrangler/ci-model.vrm', 'CI BUILD FIXTURE - NOT AN AVATAR');
    return;
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  (production ? validateProductionTarget : validateTarget)(config);
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
    if (production) validateProductionActivation(process.env.PRODUCTION_DEPLOY_ENABLED, process.env.STAGING_RESULT);
    validateVrm(await readFile('dist-public/avatar/model.vrm'), pinned);
    const latest = run('gh', ['api', 'repos/wakadorimk2/vayria/git/ref/heads/main', '--jq', '.object.sha'], true);
    validateRevision(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, process.env.GITHUB_SHA,
      run('git', ['rev-parse', 'HEAD'], true), latest);
    return;
  }
  if (action === 'deploy') {
    await runCd('guard', environment);
    const result = run(process.execPath, ['node_modules/wrangler/wrangler-dist/cli.js', 'deploy', '--config', configPath, '--env-file', 'deploy/placeholder.env'], true);
    // Wrangler output contains deployment metadata only; never print environment values.
    const version = result.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
    if (!version) throw new Error('Deployment returned no Worker Version ID. Inspect Cloudflare before retrying.');
    const summary = label + ' deployed\n\nCommit: ' + process.env.GITHUB_SHA + '\n\nWorker Version: ' + version + '\n\nURL: ' + url + '\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  if (action === 'smoke') {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (production) {
          const html = await readFile('dist-public/index.html', 'utf8');
          const scriptPath = html.match(/src="(\/assets\/[A-Za-z0-9_.-]+\.js)"/)?.[1];
          if (!scriptPath) throw new Error('Build has no entry script.');
          await productionSmoke(fetch, pinned, html, await readFile('dist-public' + scriptPath));
          console.log('Production smoke passed: page, script, avatar, Cookie and generation status. No generation requests.');
          return;
        }
        const page = await fetch(STAGING_URL, { signal: AbortSignal.timeout(10000) });
        const api = await fetch(STAGING_URL + '/api/session', { signal: AbortSignal.timeout(10000) });
        if (page.status !== 401 || !(await page.text()).includes('検証用アクセスチケット') ||
            api.status !== 403 || (await api.json()).code !== 'preview_access_required') throw new Error('Staging access gate check failed.');
        console.log('Staging smoke passed: root 401; session 403. No generation requests.');
        return;
      } catch (error) {
        if (attempt === 4) {
          if (production) {
            const warning = 'Production smoke failed. Deployment may already be live. Check the Worker Version above; disable production CD and follow the recovery runbook. No automatic rollback.\n';
            console.error(warning);
            if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, warning);
          }
          throw error;
        }
        await new Promise(done => setTimeout(done, 5000));
      }
    }
  }
  else throw new Error('Expected fixture, download, guard, deploy, or smoke.');
}
