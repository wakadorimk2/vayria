import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023', external: ['cloudflare:workers'] });
test('exhibit enrollment, repeated handoff, revoked access and budget rejection run through the real Worker and SQLite', async () => {
  const secret = 'exhibition-local-test-'.repeat(3), base = 'https://test.example';
  const externalCalls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'exhibition-test', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
    bindings: { COOKIE_SECRET: secret, IP_SECRET: secret, ADMIN_SECRET: secret, OPENAI_API_KEY: 'mock-openai', AIVIS_API_KEY: 'mock-aivis',
      AIVIS_MODEL_UUID: 'mock-model', AIVIS_SPEAKER_UUID: 'mock-speaker', GENERATION_ENABLED: 'true',
      REQUIRE_PREVIEW_ACCESS: 'false', PUBLIC_HOSTNAME: 'test.example' },
    serviceBindings: { ASSETS: () => new Response('public app') },
    outboundService: request => { externalCalls.push(request.url); return Response.json({ error: 'Unexpected external request' }, { status: 502 }); },
  }] }));
  const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 600000 })).toString('base64url');
  const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  const post = (path, input, cookie = '', extra = {}) => mf.dispatchFetch(base + path, { method: 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...extra }, body: JSON.stringify(input) });
  const admin = input => post('/api/admin', input, '', { Authorization: `Bearer ${token}` });
  const cookie = async () => (await mf.dispatchFetch(base + '/api/session')).headers.get('set-cookie').split(';')[0];
  try {
    const a = await cookie(), b = await cookie();
    const config = { op: 'exhibition-create', event: 'test', starts: Date.now() - 1000, expires: Date.now() + 3600000, budget: 1 };
    assert.equal((await post('/api/admin', config)).status, 401);
    assert.equal((await admin(config)).status, 200);
    assert.equal((await admin(config)).status, 400); // Recreating never resets spending.
    assert.equal((await post('/api/exhibition/next', { requestId: crypto.randomUUID(), epoch: 0 }, a)).status, 403);
    assert.equal((await post('/api/session?exhibition=true', { exhibition: true }, a)).status, 403);
    assert.equal((await post('/api/exhibition/enroll', { code: 'f'.repeat(32) }, a)).status, 403);
    const issued = await (await admin({ op: 'exhibition-code', event: 'test' })).json();
    assert.equal((await post('/api/exhibition/enroll', { code: issued.code }, a, { Origin: 'https://evil.example' })).status, 403);
    const results = await Promise.all([post('/api/exhibition/enroll', { code: issued.code }, a), post('/api/exhibition/enroll', { code: issued.code }, b)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
    const enrolled = results[0].status === 200 ? a : b;
    const registration = await results.find(r => r.status === 200).json();
    const epoch = registration.exhibition.epoch;
    assert.equal(registration.exhibition.budgetYen, .000001);
    assert.equal((await post('/api/session', { epoch: epoch - 1 }, enrolled)).status, 403);
    let started = await (await post('/api/session', { epoch }, enrolled)).json();
    assert.ok(started.session.id); assert.equal(externalCalls.length, 0); // No Turnstile for an enrolled device.
    const card = { cardId: 'chicken', performanceContext: { callbackTendency: 0, fragmentation: 0, semanticBiases: [] } };
    const rejected = await post('/api/card-preview', card, enrolled, { 'X-Vayria-Session': started.session.id });
    assert.equal(rejected.status, 429); assert.equal((await rejected.json()).code, 'exhibition_budget');
    assert.equal(externalCalls.length, 0);
    const nextRequest = { requestId: crypto.randomUUID(), epoch };
    const handoffs = await Promise.all([post('/api/exhibition/next', nextRequest, enrolled), post('/api/exhibition/next', nextRequest, enrolled)]);
    for (const response of handoffs) { assert.equal(response.status, 200); assert.equal((await response.json()).exhibition.epoch, epoch + 1); }
    assert.equal((await post('/api/card-preview', card, enrolled, { 'X-Vayria-Session': started.session.id })).status, 401);
    started = await (await post('/api/session', { epoch: epoch + 1 }, enrolled)).json();
    assert.equal((await (await post('/api/exhibition/next', nextRequest, enrolled)).json()).session.id, started.session.id);
    const report = await (await admin({ op: 'report' })).json();
    assert.equal(report.dayYen, 0); assert.equal(report.monthApiYen, 0);
    const visitor = Object.keys(report.exhibitionDevices)[0];
    assert.equal((await admin({ op: 'exhibition-revoke', visitor })).status, 200);
    assert.equal((await post('/api/session', { epoch: epoch + 2 }, enrolled)).status, 403);
    assert.equal((await post('/api/card-preview', card, enrolled, { 'X-Vayria-Session': started.session.id })).status, 401);
    assert.equal((await admin({ op: 'exhibition-stop', event: 'test' })).status, 200);
    assert.equal(externalCalls.length, 0);
  } finally { await mf.dispose(); }
});
