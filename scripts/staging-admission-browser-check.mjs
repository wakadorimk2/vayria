// Optional browser check against local Workers and SQLite. No external requests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:workers'] });
const secret = 'browser-local-secret-'.repeat(3);
const ticketPayload = Buffer.from(JSON.stringify({ purpose: 'preview', exp: Date.now() + 600000 })).toString('base64url');
const ticket = ticketPayload + '.' + createHmac('sha256', secret).update(ticketPayload).digest('base64url');
const workers = ['', '/staging'].map((mount, i) => new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: i ? 'staging' : 'production', script: bundle.outputFiles[0].text, modules: true,
  compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
  bindings: { PUBLIC_BASE_PATH: mount, REQUIRE_PREVIEW_ACCESS: i ? 'true' : 'false', PUBLIC_HOSTNAME: 'localhost',
    COOKIE_SECRET: secret, PREVIEW_SECRET: secret, IP_SECRET: secret, ADMIN_SECRET: secret, GENERATION_ENABLED: 'false' },
  serviceBindings: { ASSETS: async request => {
    const root = resolve(i ? 'dist-public' : '.wrangler/root-build');
    const path = new URL(request.url).pathname;
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep)) return new Response(null, { status: 404 });
    try { return new Response(await readFile(file), { headers: { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] ?? 'application/octet-stream' } }); }
    catch { return new Response(null, { status: 404 }); }
  } },
  outboundService: () => { throw Error('External requests are forbidden'); },
}] })));
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = `http://${req.headers.host}${req.url}`;
    const headers = { ...req.headers, 'CF-Connecting-IP': '127.0.0.1' };
    const response = await workers[req.url.startsWith('/staging') ? 1 : 0].dispatchFetch(url, {
      method: req.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
    });
    res.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const root = await context.newPage(), staging = await context.newPage();
  await Promise.all([root.waitForResponse(r => r.url() === base + '/api/session' && r.status() === 200), root.goto(base + '/')]);
  const productionCookie = (await context.cookies()).find(cookie => cookie.name === '__Host-vayria'); assert.ok(productionCookie);
  await staging.goto(base + '/staging/');
  await staging.getByLabel('検証用アクセスチケット').fill(ticket);
  await staging.getByRole('button', { name: '開く', exact: true }).click();
  await staging.getByRole('button', { name: '設定', exact: true }).waitFor();
  assert.equal(staging.url(), base + '/staging/');
  assert.equal(await staging.evaluate(async () => {
    await fetch('/staging/api/session');
    return (await (await fetch('/staging/api/session')).json()).cookieReady;
  }), true);
  const cookies = await context.cookies();
  for (const name of ['__Host-vayria', '__Host-vayria-staging', '__Host-vayria-staging-preview']) {
    const cookie = cookies.find(item => item.name === name); assert.ok(cookie, name);
    assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
  }
  assert.equal(cookies.find(cookie => cookie.name === '__Host-vayria').value, productionCookie.value);
  await staging.reload(); await staging.getByRole('button', { name: '設定', exact: true }).waitFor();
  assert.equal(staging.url(), base + '/staging/');
  await root.reload(); await root.getByRole('button', { name: '設定', exact: true }).waitFor();
  assert.equal((await context.cookies()).find(cookie => cookie.name === '__Host-vayria').value, productionCookie.value);
  const expired = await context.cookies();
  await context.clearCookies();
  await context.addCookies(expired.filter(cookie => cookie.name !== '__Host-vayria-staging-preview'));
  await staging.reload(); await staging.getByLabel('検証用アクセスチケット').waitFor();
  assert.equal((await context.cookies()).find(cookie => cookie.name === '__Host-vayria').value, productionCookie.value);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['real-worker-admission', 'same-browser-cookie-isolation', 'authenticated-reload-stays-in-staging', 'admission-loss-does-not-reset-production'], externalRequests: 0 }));
} finally {
  await browser.close(); await new Promise(done => server.close(done)); await Promise.all(workers.map(worker => worker.dispose()));
}
