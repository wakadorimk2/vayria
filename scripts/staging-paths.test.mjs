import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { adminTarget } from './public-admin-target.mjs';
import { validateBuildBase } from './public-cd.mjs';

test('admin destinations preserve staging and reject ambiguous or old endpoints', () => {
  for (const path of ['/staging', '/staging/']) {
    const target = adminTarget('https://vayria.me' + path);
    assert.equal(target.url.href, 'https://vayria.me/staging/api/admin'); assert.equal(target.staging, true);
  }
  assert.equal(adminTarget('https://vayria.me').staging, false);
  assert.equal(adminTarget('https://vayria.me').url.pathname, '/api/admin');
  for (const url of ['https://staging.vayria.me', 'https://vayria.me/staging-other', 'https://vayria.me/?x=1', 'https://other.example', 'http://vayria.me', 'https://user@vayria.me']) assert.throws(() => adminTarget(url));
});

test('build guard rejects a bundle for the other mount', () => {
  const root = '<script type="module" src="/assets/app.js"></script>';
  const staging = root.replace('/assets/', '/staging/assets/');
  validateBuildBase(root, 'production'); validateBuildBase(staging, 'staging');
  assert.throws(() => validateBuildBase(root, 'staging'));
  assert.throws(() => validateBuildBase(staging, 'production'));
});

test('browser URL helpers and saved state keep the staging mount without double prefixes', async () => {
  const built = await build({ stdin: { contents: 'export * from "./src/public/paths"; export * from "./src/storageKey";', resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', define: { 'import.meta.env.BASE_URL': '"/staging/"' } });
  const helpers = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  assert.equal(helpers.publicUrl('/api/session'), '/staging/api/session');
  assert.equal(helpers.publicUrl('/staging/api/tts'), '/staging/api/tts');
  assert.equal(helpers.publicUrl('/'), '/staging/');
  assert.equal(helpers.publicPagePath('/staging/exhibition'), '/exhibition');
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { pathname: '/' } }; assert.equal(helpers.environmentStorageKey('saved'), 'saved');
    globalThis.window.location.pathname = '/staging/'; assert.equal(helpers.environmentStorageKey('saved'), 'staging:saved');
    globalThis.window.location.pathname = '/staging-other'; assert.equal(helpers.environmentStorageKey('saved'), 'saved');
  } finally { globalThis.window = previous; }
});

test('mounted Workers isolate Cookie and SQLite state, retain admission, and redirect only legacy reads', async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:workers'] });
  const assets = [], external = [], secret = 'path-test-secret-'.repeat(4);
  const signed = (purpose, exp = Date.now() + 60000) => {
    const payload = Buffer.from(JSON.stringify({ purpose, exp })).toString('base64url');
    return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  };
  const instances = ['', '/staging'].map((base, i) => new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: i ? 'staging' : 'production', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
    bindings: { PUBLIC_BASE_PATH: base, PUBLIC_HOSTNAME: 'vayria.me', REQUIRE_PREVIEW_ACCESS: i ? 'true' : 'false',
      PREVIEW_SECRET: secret, COOKIE_SECRET: secret, IP_SECRET: secret, ADMIN_SECRET: secret, GENERATION_ENABLED: 'true' },
    serviceBindings: { ASSETS: request => { const path = new URL(request.url).pathname; assets.push({ base, path });
      if (path === '/redirect') return new Response(null, { status: 308, headers: { Location: '/redirect/' } });
      return new Response(path === '/' ? '<div id="root"></div>' : 'asset'); } },
    outboundService: request => { external.push(request.url); throw Error('No provider calls allowed'); },
  }] })));
  try {
    const staging = { fetch: (...args) => instances[1].dispatchFetch(...args) };
    const production = { fetch: (...args) => instances[0].dispatchFetch(...args) };
    const origin = 'https://vayria.me';
    const get = (path, cookie = '') => staging.fetch(origin + path, { headers: { Cookie: cookie }, redirect: 'manual' });
    for (const method of ['GET', 'HEAD']) {
      const old = await staging.fetch('https://staging.vayria.me/exhibition?view=test', { method, redirect: 'manual' });
      assert.equal(old.status, 302); assert.equal(old.headers.get('location'), origin + '/staging/exhibition?view=test');
    }
    const oldPost = await staging.fetch('https://staging.vayria.me/api/admin', { method: 'POST', redirect: 'manual' });
    assert.equal(oldPost.status, 409); assert.equal(oldPost.headers.get('location'), null);
    assert.equal((await oldPost.json()).url, origin + '/staging/api/admin');
    assert.equal((await get('/staging?x=1')).headers.get('location'), '/staging/?x=1');
    for (const path of ['/staging-other', '/', '/api/session']) assert.equal((await get(path)).status, 404);
    const admission = await get('/staging/'); assert.equal(admission.status, 401);
    assert.match(await admission.text(), /action="\/staging\/preview"/);
    assert.equal((await get('/staging/api/session')).status, 403);
    const submit = (ticket, requestOrigin = origin) => staging.fetch(origin + '/staging/preview', { method: 'POST', redirect: 'manual',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket }).toString() });
    const expired = await submit(signed('preview', 1)); assert.equal(expired.status, 401, await expired.text());
    assert.equal((await submit(signed('preview'), 'https://other.example')).status, 401);
    const login = await submit(signed('preview')); assert.equal(login.status, 303); assert.equal(login.headers.get('location'), '/staging/');
    const preview = login.headers.get('set-cookie').split(';')[0]; assert.ok(preview.startsWith('__Host-vayria-staging-preview='));
    const session = await get('/staging/api/session', preview);
    const stageCookie = session.headers.get('set-cookie').split(';')[0]; assert.ok(stageCookie.startsWith('__Host-vayria-staging='));
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(session.headers.get('set-cookie').includes(flag));
    const prodSession = await production.fetch(origin + '/api/session', { headers: { Cookie: stageCookie } });
    const prodCookie = prodSession.headers.get('set-cookie').split(';')[0]; assert.ok(prodCookie.startsWith('__Host-vayria='));
    const both = `${preview}; ${stageCookie}; ${prodCookie}`;
    assert.equal((await (await get('/staging/api/session', both)).json()).cookieReady, true);
    assert.equal((await (await production.fetch(origin + '/api/session', { headers: { Cookie: both } })).json()).cookieReady, true);
    assert.equal((await (await get('/staging/api/session', `${preview}; ${prodCookie}`)).json()).cookieReady, false);
    for (const path of ['/staging/', '/staging/exhibition', '/staging/exhibition/', '/staging/assets/app.js', '/staging/avatar/model.vrm']) assert.equal((await get(path, both)).status, 200);
    assert.ok(assets.some(x => x.base === '/staging' && x.path === '/avatar/model.vrm'));
    assert.equal((await get('/staging/redirect', both)).headers.get('location'), '/staging/redirect/');
    assert.equal((await get('/staging/api/unknown', both)).status, 404);
    const admin = (worker, path, input) => worker.fetch(origin + path, { method: 'POST', headers: { Origin: origin,
      Authorization: 'Bearer ' + signed('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal((await admin(staging, '/staging/api/admin', { op: 'configure', stopped: true })).status, 200);
    assert.equal((await (await get('/staging/api/session', both)).json()).stopped, true);
    assert.equal((await (await production.fetch(origin + '/api/session', { headers: { Cookie: both } })).json()).stopped, false);
    assert.equal((await staging.fetch(origin + '/staging/api/session', { method: 'POST', headers: { Cookie: both, Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.deepEqual(external, []);
  } finally { await Promise.all(instances.map(instance => instance.dispose())); }
});
