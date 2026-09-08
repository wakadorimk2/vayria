import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';
import { validateProductionTarget, validateProductionActivation, productionSmoke, PRODUCTION_URL } from './public-cd.mjs';

const config = JSON.parse(await readFile('wrangler.production.jsonc', 'utf8'));
test('production target rejects staging, aliases, disabled generation and ledger replacement', () => {
  validateProductionTarget(config);
  for (const patch of [
    { name: 'vayria-public-staging' }, { account_id: 'another-account' }, { main: 'other.ts' },
    { routes: [{ pattern: 'staging.vayria.me', custom_domain: true }] },
    { routes: [...config.routes, { pattern: 'www.vayria.me', custom_domain: true }] },
    { routes: [{ pattern: 'vayria.me', custom_domain: false }] },
    { workers_dev: true }, { preview_urls: true },
    { assets: { ...config.assets, directory: 'deploy/placeholder' } },
    { assets: { ...config.assets, run_worker_first: false } },
    { durable_objects: { bindings: [{ name: 'USAGE', class_name: 'OtherLedger' }] } },
    { migrations: [] },
    ...Object.entries({ PUBLIC_HOSTNAME: 'staging.vayria.me', REQUIRE_PREVIEW_ACCESS: 'true',
      GENERATION_ENABLED: 'false', SERVE_PLACEHOLDER: 'true', TURNSTILE_SITE_KEY: 'wrong-site' })
      .map(([key, value]) => ({ vars: { ...config.vars, [key]: value } })),
  ]) assert.throws(() => validateProductionTarget({ ...config, ...patch }));
});

test('recovery preserves the production Worker and ledger', async () => {
  const recovery = JSON.parse(await readFile('wrangler.recovery.jsonc', 'utf8'));
  for (const key of ['name', 'account_id', 'main', 'routes', 'durable_objects', 'migrations'])
    assert.deepEqual(recovery[key], config[key]);
  assert.equal(recovery.vars.GENERATION_ENABLED, 'false');
  assert.equal(recovery.vars.SERVE_PLACEHOLDER, 'true');
});

test('actual workflow gates production on activation, successful staging and main', async () => {
  const workflow = load(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  const production = workflow.jobs['deploy-production'];
  assert.deepEqual(production.needs, ['ci', 'stt', 'public', 'deploy-staging']);
  assert.equal(production.environment.name, 'production');
  assert.deepEqual(production.concurrency, { group: 'vayria-production-deployment', 'cancel-in-progress': false });
  assert.equal(production['continue-on-error'], undefined);
  for (const enabled of ['', 'false', 'true']) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const event of ['push', 'workflow_dispatch', 'pull_request']) {
        for (const ref of ['refs/heads/main', 'refs/heads/topic']) {
          const actual = runInNewContext(production.if, {
            vars: { PRODUCTION_DEPLOY_ENABLED: enabled }, needs: { 'deploy-staging': { result } },
            github: { event_name: event, ref },
          }, { timeout: 1000 });
          assert.equal(actual, enabled === 'true' && result === 'success' && event !== 'pull_request' && ref === 'refs/heads/main');
        }
      }
      if (enabled === 'true' && result === 'success') validateProductionActivation(enabled, result);
      else assert.throws(() => validateProductionActivation(enabled, result));
    }
  }
  const deploy = production.steps.find(step => step.run === 'node scripts/production-cd.mjs deploy');
  assert.equal(deploy.env.PRODUCTION_DEPLOY_ENABLED, '${{ vars.PRODUCTION_DEPLOY_ENABLED }}');
  assert.equal(deploy.env.STAGING_RESULT, "${{ needs['deploy-staging'].result }}");
  assert.ok(production.steps.some(step => step.run === 'node scripts/production-cd.mjs smoke'));
  for (const job of [production, workflow.jobs['deploy-staging']]) {
    assert.ok(job.steps.every(step => !step['continue-on-error']));
    const serialized = JSON.stringify(job);
    assert.doesNotMatch(serialized, /OPENAI_API_KEY|AIVIS_API_KEY|ADMIN_SECRET|COOKIE_SECRET|upload-artifact/);
    assert.ok(job.steps.some(step => step.if === 'always()' && step.run?.includes("'dist-public'")));
  }
  assert.equal(runInNewContext(workflow.jobs['deploy-staging'].if, { github: { event_name: 'workflow_dispatch', ref: 'refs/heads/main' } }), true);
});

const html = '<html><div id="root"></div><script src="/assets/index-test.js"></script></html>';
const script = Buffer.from('/* built JS */');
const avatar = Buffer.from('pinned VRM');
const pinned = { bytes: avatar.length, sha256: createHash('sha256').update(avatar).digest('hex') };
function mockSite(overrides = {}) {
  const requests = [];
  let visits = 0;
  return {
    requests,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).origin, PRODUCTION_URL);
      const path = new URL(url).pathname;
      if (path === '/') return new Response(overrides.html ?? html, { headers: { 'Content-Type': 'text/html' } });
      if (path === '/assets/index-test.js') return new Response(overrides.script ?? script);
      if (path === '/avatar/model.vrm') return new Response(overrides.avatar ?? avatar);
      assert.equal(path, '/api/session');
      visits++;
      if (visits === 1) return Response.json({ cookieReady: false }, { headers: {
        'Set-Cookie': overrides.cookie ?? '__Host-vayria=signed; Secure; HttpOnly; SameSite=Strict; Path=/',
      } });
      assert.equal(options.headers.Cookie, '__Host-vayria=signed');
      return Response.json({ cookieReady: true, enabled: true, stopped: false, session: null,
        siteKey: config.vars.TURNSTILE_SITE_KEY, ...overrides.status });
    },
  };
}
test('production smoke validates build, avatar and Cookie without starting a session', async () => {
  const site = mockSite();
  await productionSmoke(site.fetch, pinned, html, script);
  assert.deepEqual(site.requests.map(request => new URL(request.url).pathname), [
    '/', '/assets/index-test.js', '/avatar/model.vrm', '/api/session', '/api/session',
  ]);
});
test('production smoke fails on a stale deployment, bad Cookie or stopped generation', async () => {
  for (const overrides of [
    { html: '<h1>準備中</h1>' }, { script: 'old bundle' }, { avatar: 'wrong avatar' },
    { cookie: '__Host-vayria=signed; Path=/' }, { status: { cookieReady: false } },
    { status: { enabled: false } }, { status: { stopped: true } },
    { status: { siteKey: 'staging-key' } }, { status: { session: { id: 'unexpected' } } },
  ]) await assert.rejects(productionSmoke(mockSite(overrides).fetch, pinned, html, script));
  await assert.rejects(productionSmoke(async () => { throw new Error('HTTPS failure'); }, pinned, html, script));
});
