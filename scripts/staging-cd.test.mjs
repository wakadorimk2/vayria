import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateTarget, validateVrm, validateRevision } from './staging-cd.mjs';
const config = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'));
test('staging target guard rejects production and extra routes', () => {
  validateTarget(config);
  for (const patch of [{ name: 'vayria-web' }, { routes: [{ pattern: 'vayria.me', custom_domain: true }] },
    { routes: [...config.routes, { pattern: 'vayria.me' }] }, { workers_dev: true }, { vars: { ...config.vars, REQUIRE_PREVIEW_ACCESS: 'false' } }])
    assert.throws(() => validateTarget({ ...config, ...patch }));
});
test('only the current main push or manual revision can pass', () => {
  const sha = 'a'.repeat(40); const other = 'b'.repeat(40);
  validateRevision('push', 'refs/heads/main', sha, sha, sha);
  validateRevision('workflow_dispatch', 'refs/heads/main', sha, sha, sha);
  for (const args of [['pull_request', 'refs/heads/main', sha, sha, sha], ['push', 'refs/heads/topic', sha, sha, sha],
    ['push', 'refs/heads/main', sha, other, sha], ['push', 'refs/heads/main', sha, sha, other],
    ['workflow_dispatch', 'refs/heads/topic', sha, sha, sha],
    ['workflow_dispatch', 'refs/heads/main', sha, sha, other]]) assert.throws(() => validateRevision(...args));
});
test('VRM guard refuses substitutions, missing bytes and the CI fixture', () => {
  const bytes = Buffer.from('pinned original');
  const manifest = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  validateVrm(bytes, manifest);
  for (const bad of [Buffer.alloc(0), Buffer.from('CI BUILD FIXTURE - NOT AN AVATAR'), Buffer.from('pinned changed!')]) assert.throws(() => validateVrm(bad, manifest));
  assert.throws(() => validateVrm(bytes, { ...manifest, bytes: bytes.length + 1 }));
});


test('staging Turnstile preparation changes only allowed domains without a Worker deployment', async () => {
  const source = (await readFile('scripts/configure-turnstile.mjs', 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let widget = { name: 'Vayria staging', sitekey: config.vars.TURNSTILE_SITE_KEY, secret: 'test-only-secret', domains: ['staging.vayria.me'], mode: 'managed', clearance_level: 'no_clearance', bot_fight_mode: false, ephemeral_id: false, offlabel: false, region: 'world' };
  const calls = [], output = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method });
    let result;
    if (path.endsWith('/challenges/widgets')) result = [widget];
    else if (path.endsWith('/challenges/widgets/' + widget.sitekey)) {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.domains, ['staging.vayria.me', 'vayria.me']);
        for (const key of ['name', 'mode', 'clearance_level', 'bot_fight_mode', 'ephemeral_id', 'offlabel', 'region']) assert.deepEqual(body[key], widget[key]);
        widget = { ...widget, ...body };
      }
      result = widget;
    } else if (path.endsWith('/workers/scripts/vayria-public-staging/secrets') && options.method === 'GET') result = [{ name: 'TURNSTILE_SECRET' }];
    else throw new Error('Unexpected Cloudflare action ' + path);
    return Response.json({ success: true, result });
  };
  const run = () => new AsyncFunction('readFile', 'writeFile', 'join', 'process', 'fetch', 'console', source)(
    async path => path === 'wrangler.public.jsonc' ? JSON.stringify(config) : 'oauth_token = "mock-token"',
    async () => { throw new Error('Config must stay unchanged'); }, (...parts) => parts.join('/'),
    { env: { APPDATA: 'mock' }, argv: ['node', 'script', '--staging'] }, fetch, { log: value => output.push(value) });
  await run(); await run();
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.ok(calls.every(call => !call.path.includes('vayria-web')));
  assert.doesNotMatch(output.join(''), /test-only-secret|mock-token/);
});
