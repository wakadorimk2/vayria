import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';
import sharp from 'sharp';
import { createHmac } from 'node:crypto';

const outdir = resolve('node_modules/.tmp/security-tests');
await build({ entryPoints: { localApi: 'server/localApi.ts', localRequestSecurity: 'server/localRequestSecurity.ts', voiceStreamProxy: 'server/voiceStreamProxy.ts', visual: 'worker/visual.ts' }, outdir,
  bundle: true, packages: 'external', platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
const { handleRequest } = await import(pathToFileURL(resolve(outdir, 'localApi.mjs')));
const { voiceStreamProxyPlugin } = await import(pathToFileURL(resolve(outdir, 'voiceStreamProxy.mjs')));
const { visualRoute } = await import(pathToFileURL(resolve(outdir, 'visual.mjs')));
const { isAllowedLocalRequest } = await import(pathToFileURL(resolve(outdir, 'localRequestSecurity.mjs')));

test('local origin checks preserve HTTPS, exhibition mDNS, IPv6 and LAN access', () => {
  for (const [host, address, encrypted] of [
    ['vayria.local:5187', '192.168.1.2', true], ['192.168.1.2:5187', '192.168.1.2', true],
    ['[::1]:5187', '::1', false], ['127.0.0.1:5187', '::ffff:127.0.0.1', false],
  ]) {
    const origin = `${encrypted ? 'https' : 'http'}://${host}`;
    const req = { headers: { host, origin }, socket: { localAddress: address, encrypted } };
    assert.equal(isAllowedLocalRequest(req), true, origin);
    assert.equal(isAllowedLocalRequest({ ...req, headers: { ...req.headers, origin: origin.replace(/:\d+$/, ':9999') } }), false);
    assert.equal(isAllowedLocalRequest({ ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }), false);
  }
});

test('remote video relay rejects active content, oversize bodies and unsafe redirects', async t => {
  const secret = 'security-test-only-'.repeat(3);
  const payload = Buffer.from(JSON.stringify({ purpose: 'visual-media', visitor: 'v', session: 's', key: 'asset', exp: Date.now() + 60000 })).toString('base64url');
  const ticket = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  const env = { COOKIE_SECRET: secret, MANIFESTATION_ENABLED: 'true', VISUAL_ASSETS: { get: async () => null } };
  const ledger = async op => op === 'visualMediaLookup' ? { url: 'https://fal.media/video.mp4' } : {};
  const read = () => visualRoute(new Request('https://test/api/visual/media/asset?ticket=' + ticket), env, 'v', 's', ledger);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const upstream of [
    new Response('<script>bad()</script>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('video', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(32 * 1024 * 1024 + 1) } }),
    new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
  ]) {
    globalThis.fetch = async (_url, init) => { assert.equal(init.redirect, 'manual'); return upstream; };
    await assert.rejects(read(), /media_failed/);
  }
  globalThis.fetch = async (_url, init) => {
    assert.ok(init.signal);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    } }), { headers: { 'Content-Type': 'video/mp4' } });
  };
  await assert.rejects((await read()).arrayBuffer(), /media_too_large/);
  globalThis.fetch = async () => new Response('video', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/5' } });
  const valid = await read(); assert.equal(valid.status, 206); assert.equal(await valid.text(), 'video');
});

test('local image processing rejects HEIF/AVIF before parsing and preserves PNG', async () => {
  const input = { create: { width: 4, height: 4, channels: 4, background: { r: 50, g: 20, b: 10, alpha: 0.5 } } };
  const png = await sharp(input).png().toBuffer();
  assert.equal((await sharp(png).metadata()).format, 'png');
  // Generate a harmless AVIF; no malformed native-code exploit is executed.
  const avif = await sharp(input).avif().toBuffer();
  await assert.rejects(sharp(avif).metadata(), /blocked|unsupported/i);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('local API rejects foreign browser origins before parsing or calling a provider', async t => {
  const server = createServer((req, res) => { void handleRequest(req, res, { mode: 'local' }); });
  const origin = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const path of ['/api/chat', '/api/tts', '/api/world/mutate', '/api/manifestation/generate']) {
    for (const hostile of ['https://attacker.example', 'null', `${origin}.attacker.example`]) {
      const response = await fetch(origin + path, { method: 'POST',
        headers: { Origin: hostile, 'Content-Type': 'text/plain' }, body: '{}' });
      assert.equal(response.status, 403, `${path}: ${hostile}`);
      await response.text();
    }
  }
  for (const headers of [{}, { Origin: origin }]) {
    const response = await fetch(origin + '/api/world/mutate', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 404); // Native and same-origin clients reach the disabled feature.
    await response.text();
  }
});

test('local API rejects an attacker-controlled Host even when Origin matches it', async t => {
  const server = createServer((req, res) => { void handleRequest(req, res, { mode: 'local' }); });
  const origin = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const status = await new Promise((resolveStatus, reject) => {
    const req = request(origin + '/api/world/mutate', { method: 'POST', headers: {
      Host: 'attacker.example', Origin: 'http://attacker.example', 'Content-Type': 'text/plain',
    } }, res => { res.resume(); resolveStatus(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 403);
});

test('voice bridge rejects foreign origins and limits frames before forwarding', async t => {
  let forwarded = 0;
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  upstream.on('connection', ws => ws.on('message', () => { forwarded++; ws.send('accepted'); }));
  const server = createServer();
  voiceStreamProxyPlugin(`ws://127.0.0.1:${upstream.address().port}/stream`).configureServer({ httpServer: server });
  const origin = await listen(server);
  const clients = [];
  t.after(() => { for (const ws of clients) ws.terminate(); for (const ws of upstream.clients) ws.terminate(); upstream.close(); server.close(); });
  const rejected = new WebSocket(origin.replace('http:', 'ws:') + '/api/voice-stream', { origin: 'https://attacker.example' });
  clients.push(rejected);
  const status = await new Promise((done, reject) => {
    rejected.on('unexpected-response', (_req, res) => { res.resume(); done(res.statusCode); rejected.terminate(); });
    rejected.on('open', () => done(101));
    rejected.on('error', error => { if (!String(error).includes('before the connection')) reject(error); });
  });
  assert.equal(status, 403);
  const client = new WebSocket(origin.replace('http:', 'ws:') + '/api/voice-stream', { origin });
  clients.push(client);
  await once(client, 'open');
  const received = once(client, 'message'); client.send(Buffer.alloc(6400)); await received;
  assert.equal(forwarded, 1);
  const closed = once(client, 'close'); client.send(Buffer.alloc(65537));
  assert.equal((await closed)[0], 1009);
  assert.equal(forwarded, 1);
});
