// Public exhibition E2E harness.
//
// Runs the real public Worker (`worker/shared/index.ts`) on Miniflare with
// SQLite-backed Durable Objects (PublicUsage + WorldRoom in a separate storage
// worker) and the private WorldExecution entrypoint bound as a service binding,
// mirroring wrangler.production.jsonc + wrangler.world-production.jsonc.
// Browsers drive `dist-public` through the real HTTP port. Every outbound fetch
// from the Worker is intercepted by `outboundService`; no paid provider is ever
// contacted.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');

export const ROOM_ID = 'main-world';
const COMPATIBILITY_DATE = '2026-09-07';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];

const SECRETS = {
  // Every secret must be >= 32 chars or security.ts refuses to sign/verify.
  COOKIE_SECRET: 'e2e-cookie-secret-not-real-32chars',
  IP_SECRET: 'e2e-ip-secret-not-real-0000-32chars',
  ADMIN_SECRET: 'e2e-admin-secret-not-real-000-32ch',
  PREVIEW_SECRET: 'e2e-preview-secret-not-real-32ch',
  TURNSTILE_SECRET: 'e2e-turnstile-secret-not-real-32',
  TURNSTILE_SITE_KEY: 'e2e-turnstile-site-key',
  OPENAI_API_KEY: 'e2e-openai-key-not-real',
  AIVIS_API_KEY: 'e2e-aivis-key-not-real',
  // Public, non-secret model identifiers from wrangler.production.jsonc.
  AIVIS_MODEL_UUID: '7fc08a41-b64d-456d-8b22-8e1284674775',
  AIVIS_SPEAKER_UUID: '8e2dfde9-a155-4bd8-b451-80832ad5e8ac',
};

let bundlePromise;
function workerBundles() {
  bundlePromise ??= (async () => {
    const options = { bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:workers'], logLevel: 'silent' };
    // Cloudflare injects CF-Connecting-IP on real edge requests; Miniflare's
    // loopback does not, and ipKey() refuses headerless requests with 503.
    const entry = `import worker from './worker/shared/index.ts';
export * from './worker/shared/index.ts';
export default { fetch(request, env, ctx) {
  if (!request.headers.get('cf-connecting-ip')) {
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', '192.0.2.100');
    request = new Request(request, { headers });
  }
  return worker.fetch(request, env, ctx);
} };`;
    const [main, storage] = await Promise.all([
      build({ stdin: { contents: entry, resolveDir: '.', sourcefile: 'e2e-entry.ts', loader: 'ts' }, ...options }),
      build({ entryPoints: ['worker/worldWorker.ts'], ...options }),
    ]);
    return { main: main.outputFiles[0].text, storage: storage.outputFiles[0].text };
  })();
  return bundlePromise;
}

// Minimal RGBA PNG accepted by worker/visualMedia.ts inspectVisualPng:
// 8-bit RGBA, fully transparent 2px border, opaque center.
let cachedPng;
export function testPng(width = 16, height = 16) {
  if (cachedPng) return cachedPng;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = data => {
    let c = 0xffffffff;
    for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      const p = row + 1 + x * 4;
      raw[p] = 90; raw[p + 1] = 60; raw[p + 2] = 160; raw[p + 3] = edge ? 0 : 255;
    }
  }
  cachedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return cachedPng;
}

// Per-provider behaviour: 'ok' | 'error' | 'hang' | number (delay ms).
export function createProviderMock() {
  const calls = [];
  const state = { responses: 'ok', transcribe: 'ok', aivis: 'ok', turnstile: 'ok', fal: 'ok' };
  const hanging = new Set();
  let replyText = message => `「${message}」への返答です。`;
  let worldIntent = () => ({ actions: [] });
  const gate = async (name, request, ok) => {
    calls.push({ provider: name, url: request.url, method: request.method, at: Date.now() });
    const mode = state[name];
    if (mode === 'hang') { await new Promise(done => hanging.add(done)); return new Response('provider released', { status: 502 }); }
    if (typeof mode === 'number') await new Promise(done => setTimeout(done, mode));
    if (mode === 'error') return new Response('e2e forced provider failure', { status: 500 });
    return ok(request);
  };
  // The worker replies must satisfy server/chatValidation.ts: a speaking turn
  // needs 1-2 activatedCards drawn from the five brain cards listed in the
  // dynamic prompt, the forced card first, plus mode-specific header fields.
  const buildReply = body => {
    const format = body?.text?.format ?? {};
    const schema = format.schema ?? {};
    const required = new Set(schema.required ?? []);
    const props = schema.properties ?? {};
    const input = Array.isArray(body?.input) ? body.input : [];
    const texts = item => (typeof item?.content === 'string' ? [item.content] : Array.isArray(item?.content) ? item.content : [])
      .map(c => (typeof c === 'string' ? c : c?.text ?? ''));
    const prompt = input.filter(i => i?.role === 'developer').flatMap(texts).join('\n');
    // Only the newest user turn — earlier history items ride along in `input`.
    const user = input.filter(i => i?.role === 'user').flatMap(texts).at(-1)?.trim() ?? '';
    const brain = [...prompt.matchAll(/^- ([\w-]+) \([^\n]*\)$/gm)].map(m => m[1]);
    const forced = /The card ([\w-]+) is forced for this reply\./.exec(prompt)?.[1] ?? null;
    const isVoice = required.has('voiceAction');
    const isAutonomous = required.has('externalAction');
    const reasonIds = (props.usedReasonIds ?? props.deliveryHeader?.properties?.usedReasonIds)?.items?.enum ?? [];
    const delivery = {
      ...(isVoice ? { voiceAction: 'take_floor', backchannelCue: 'none' } : {}),
      ...(isAutonomous ? { externalAction: 'speak', usedReasonIds: reasonIds.slice(0, 1) } : {}),
      emotion: 'neutral', speechAct: 'answer', expressionLevel: 'low',
    };
    const noneVisual = { type: 'none', action: 'add', concept: '', modifiers: [], targetId: '', motion: '', motionEvidence: '', sharing: 'general', regenerate: false };
    const text = isAutonomous ? 'みんなのカードを受け取ったよ。' : replyText(user || '挨拶');
    const payload = {};
    if (required.has('worldIntent') || props.worldIntent) payload.worldIntent = worldIntent({ brainCardIds: brain });
    if (required.has('deliveryHeader') || props.deliveryHeader) {
      payload.deliveryHeader = {
        ...(props.deliveryHeader?.properties?.visualIntent ? { visualIntent: noneVisual } : {}),
        ...delivery,
      };
      payload.speechLead = '';
      payload.speechUnits = [text];
    } else {
      Object.assign(payload, { text }, delivery);
      if (props.visualIntent) payload.visualIntent = noneVisual;
    }
    payload.activatedCards = [forced ?? brain[0]].filter(Boolean).slice(0, 2);
    if (required.has('internalDelta')) payload.internalDelta = { reasonUpdates: [] };
    return payload;
  };
  const serve = async request => {
    const url = new URL(request.url);
    try {
      if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses') {
        return await gate('responses', request, async req => {
          const body = await req.json().catch(() => ({}));
          const name = body?.text?.format?.name ?? '';
          const payload = name === 'vayria_conversation_action_policy'
            ? { action: 'take_floor', backchannelCue: 'none' }
            : buildReply(body);
          const sse = [
            { type: 'response.output_text.delta', delta: JSON.stringify(payload) },
            { type: 'response.output_text.done' },
            { type: 'response.completed', response: { model: 'gpt-5-nano', usage: { input_tokens: 10, output_tokens: 10 }, service_tier: 'default' } },
          ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
        });
      }
      if (url.hostname === 'api.openai.com' && url.pathname === '/v1/audio/transcriptions') {
        return await gate('transcribe', request, () =>
          Response.json({ text: '模擬の音声入力です', usage: { input_tokens: 10, output_tokens: 5 } }));
      }
      if (url.hostname === 'api.aivis-project.com') {
        return await gate('aivis', request, () =>
          new Response(new Uint8Array(24000), { headers: { 'Content-Type': 'audio/mpeg' } }));
      }
      if (url.hostname === 'challenges.cloudflare.com') {
        return await gate('turnstile', request, () =>
          Response.json({ success: true, hostname: '127.0.0.1', action: 'session' }));
      }
      if (url.hostname === 'api.fal.ai') {
        return await gate('fal', request, () => {
          const model = url.searchParams.get('endpoint_id') ?? '';
          const unit = /birefnet/.test(model) ? 'compute seconds' : /minimax/.test(model) ? 'seconds' : 'megapixels';
          return Response.json({ prices: [{ endpoint_id: model, unit_price: 0.001, unit, currency: 'USD' }] });
        });
      }
      if (url.hostname === 'queue.fal.run') {
        return await gate('fal', request, async req => {
          if (req.method === 'POST') {
            const model = decodeURIComponent(url.pathname.replace(/^\//, ''));
            return Response.json({
              request_id: 'e2e-task', gateway_request_id: 'e2e-task',
              status_url: `https://queue.fal.run/${model}/requests/e2e-task/status`,
              response_url: `https://queue.fal.run/${model}/requests/e2e-task`,
            });
          }
          if (url.pathname.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
          if (url.pathname.includes('birefnet')) return Response.json({ image: { url: 'https://fal.media/files/e2e/mask.png' } });
          return Response.json({ images: [{ url: 'https://fal.media/files/e2e/image.png' }] });
        });
      }
      if (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media')) {
        return await gate('fal', request, () => new Response(testPng(), { headers: { 'Content-Type': 'image/png' } }));
      }
      calls.push({ provider: 'unexpected', url: request.url, method: request.method, at: Date.now() });
      console.error('[providers] unexpected outbound:', request.method, request.url);
      return new Response('unexpected outbound request', { status: 502 });
    } catch (error) {
      console.error('[providers] mock failure:', request.method, request.url, error);
      return new Response(`mock failure: ${error instanceof Error ? error.message : error}`, { status: 502 });
    }
  };
  return {
    calls, state, serve,
    set(name, mode) { state[name] = mode; },
    release() { for (const done of [...hanging]) done(); hanging.clear(); },
    setReply(fn) { replyText = fn; },
    // Accepts an intent object or a factory ({ brainCardIds }) => intent.
    setWorldIntent(intent) { worldIntent = typeof intent === 'function' ? intent : () => intent; },
    count(name) { return calls.filter(c => c.provider === name).length; },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.vrm': 'model/gltf-binary', '.vrma': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};
function assetFetcher(root) {
  return async request => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

// Starts the production-shaped stack on an ephemeral port.
// env overrides/extends the main worker bindings (e.g. MANIFESTATION_ENABLED).
export async function startStack({ assetsRoot = 'dist-public', env = {} } = {}) {
  const root = resolve(assetsRoot);
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(`${assetsRoot}/index.html is missing. Run \`npm run public:build\` first.`);
  }
  const { main, storage } = await workerBundles();
  const providers = createProviderMock();
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    log: new Log(process.env.E2E_MF_LOG === '1' ? LogLevel.DEBUG : LogLevel.ERROR),
    workers: [
      {
        name: 'vayria-web', modules: true, script: main,
        compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS,
        durableObjects: {
          USAGE: { className: 'PublicUsage', useSQLite: true },
          WORLD_ROOMS: { className: 'WorldRoom', scriptName: 'world-storage', useSQLite: true },
        },
        r2Buckets: ['VISUAL_ASSETS'],
        serviceBindings: { ASSETS: assetFetcher(root) },
        outboundService: providers.serve,
        bindings: {
          ...SECRETS,
          GENERATION_ENABLED: 'true', REQUIRE_PREVIEW_ACCESS: 'false', PUBLIC_HOSTNAME: '127.0.0.1',
          SHARED_WORLD_ENABLED: 'true', SHARED_CONVERSATION_ENABLED: 'true', PUBLIC_WORLD_ROOM: ROOM_ID,
          VISUAL_VIDEO_ENABLED: 'true',
          ...env,
        },
      },
      {
        name: 'world-storage', modules: true, script: storage,
        compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS,
        durableObjects: { WORLD_STORAGE: { className: 'WorldRoom', useSQLite: true } },
        serviceBindings: { WORLD_EXECUTOR: { name: 'vayria-web', entrypoint: 'WorldExecution' } },
        bindings: { SHARED_CONVERSATION_ENABLED: 'true', SHARED_HAND_ENABLED: 'true' },
      },
    ],
  }));
  const url = await mf.ready;
  const origin = url.origin;
  const admin = async input => {
    const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 600000 })).toString('base64url');
    const token = payload + '.' + createHmac('sha256', SECRETS.ADMIN_SECRET).update(payload).digest('base64url');
    const response = await fetch(origin + '/api/admin', {
      method: 'POST', body: JSON.stringify(input),
      headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`admin op ${input.op} failed: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  return {
    mf, origin, providers, admin,
    roomId: ROOM_ID,
    dispose: () => mf.dispose(),
  };
}

export async function launchBrowser() {
  return chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: process.env.E2E_HEADED !== '1',
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

// One exhibition client = one browser context (own cookies/storage).
export async function newClient(browser, stack, { name = 'client' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1366 }, hasTouch: true,
    permissions: ['microphone'], ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  const worldSockets = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('websocket', socket => { if (socket.url().includes('/api/world-room/')) worldSockets.push(socket); });
  // Track every acquired microphone track and playback buffer source so tests
  // can prove handoff and participant changes release real capture/playback.
  await page.addInitScript(() => {
    window.__vayriaTracks = [];
    window.__vayriaSources = [];
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = createSource.call(this), record = { started: false, stopped: false, ended: false };
      window.__vayriaSources.push(record);
      const start = source.start.bind(source), stop = source.stop.bind(source);
      source.start = (...args) => { record.started = true; return start(...args); };
      source.stop = (...args) => { record.stopped = true; return stop(...args); };
      source.addEventListener('ended', () => { record.ended = true; });
      return source;
    };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await acquire(constraints);
      window.__vayriaTracks.push(...stream.getTracks());
      return stream;
    };
  });
  // The exhibition must never contact third parties from the browser.
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(stack.origin) || !/^https?:/.test(url)) return route.continue();
    external.push(url);
    return route.abort();
  });
  const client = {
    name, context, page, errors, external, worldSockets,
    async open(path = '/') { await page.goto(stack.origin + path, { waitUntil: 'domcontentloaded' }); },
    async enroll(code) {
      await page.goto(stack.origin + '/exhibition', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const input = document.querySelector('#exhibition-code');
        return input && !input.disabled;
      }, null, { timeout: 20000 });
      await page.locator('#exhibition-code').fill(code);
      await page.getByRole('button', { name: 'この端末を登録', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
      await page.locator('.public-controls__actions').waitFor({ timeout: 20000 });
    },
    // Room membership + state API reachable (join completed, cookie stored).
    async waitWorldConnected(timeout = 15000) {
      await page.waitForFunction(async roomId => {
        try { return (await fetch(`/api/world-room/${roomId}/state`)).ok; }
        catch { return false; }
      }, ROOM_ID, { timeout });
    },
    // Most recent world-room WebSocket that is still open. `after` requires a
    // socket created beyond an earlier watermark, so a reload cannot return a
    // pre-navigation socket whose close has not propagated yet.
    async waitWorldSocket(timeout = 30000, after = 0) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const socket = worldSockets.at(-1);
        if (socket && worldSockets.length > after && !socket.isClosed()) return socket;
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error(`world socket never connected (${name})`);
    },
    worldSocketCount() { return worldSockets.length; },
    async openCards() {
      const panel = page.locator('#shared-world-card-panel');
      if (!(await panel.count())) await page.getByRole('button', { name: '世界にいたずら', exact: true }).click();
      await panel.waitFor({ timeout: 10000 });
    },
    // Tap a hand card, then tap a shared slot to commit it. Slots float
    // continuously, so stability-gated clicks would never land.
    async insertCard() {
      await client.openCards();
      await page.locator('.card-zone--hand [data-hand-card]').first().click({ force: true });
      await page.locator('.card-zone--brain [data-world-slot]').first().click({ force: true });
      try {
        await page.locator('.shared-world-receipt').filter({ hasText: '受け付けました' }).waitFor({ timeout: 10000 });
      } catch (error) {
        const notice = await page.locator('.shared-world-receipt').first().textContent().catch(() => '');
        if (notice?.trim()) throw new Error(`card insert rejected: ${notice.trim()}`);
        throw error;
      }
    },
    async sendText(text) {
      // The toggle event is fire-and-forget; only click it when the panel is
      // actually closed, then wait for the app-shell attribute before typing.
      const isOpen = () => page.evaluate(() => document.querySelector('.app-shell')?.getAttribute('data-public-text-input') === 'true');
      if (!(await isOpen())) {
        await page.getByRole('button', { name: '文字で話す', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.app-shell')?.getAttribute('data-public-text-input') === 'true', null, { timeout: 10000 });
      }
      await page.locator('#message-input').fill(text);
      // The conversation POST is the authoritative accept/reject signal — the
      // visible status text is transient and races the DOM poller.
      const pending = page.waitForResponse(
        r => r.url().includes(`/api/world-room/${ROOM_ID}/conversation`) && r.request().method() === 'POST',
        { timeout: 30000 });
      await page.getByRole('button', { name: '送信', exact: true }).click();
      const response = await pending;
      if (!response.ok()) {
        const body = await response.json().catch(() => null);
        throw new Error(`world input rejected: ${response.status()} ${JSON.stringify(body)}`);
      }
    },
    // Send until the reply for this exact text appears. Rejection paths
    // (cooldown, already_waiting from an autonomous turn, full queue) are
    // bounded retries — what matters to the exhibition is eventual delivery.
    async say(text, timeout = 90000) {
      const expected = `「${text}」への返答です。`;
      const deadline = Date.now() + timeout;
      for (;;) {
        let rejected = false;
        try { await client.sendText(text); }
        catch (error) {
          if (!/conversation_cooldown|already_waiting|conversation_full|待って|受付済み|いっぱい|確認/.test(String(error))) throw error;
          rejected = true;
          // Cooldown receipts last 3s; an autonomous turn holding the actor
          // resolves when its slot finishes.
          await client.waitSlotDone(Math.min(30000, Math.max(1, deadline - Date.now()))).catch(() => {});
          await page.waitForTimeout(3400);
        }
        if (rejected) { if (Date.now() >= deadline) throw new Error(`world input never accepted: ${text}`); continue; }
        try {
          await client.waitReply(expected, Math.min(20000, Math.max(1, deadline - Date.now())));
          return;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await client.waitSlotDone(Math.min(60000, Math.max(1, deadline - Date.now()))).catch(() => {});
          await page.waitForTimeout(1200);
        }
      }
    },
    async waitReply(expected, timeout = 30000) {
      await page.locator('.shared-conversation-caption').filter({ hasText: expected }).first().waitFor({ timeout });
    },
    async waitQueueClear(timeout = 30000) {
      await page.waitForFunction(
        () => ![...document.querySelectorAll('.shared-conversation-status')].some(n => /準備中|順番待ち/.test(n.textContent)),
        null, { timeout });
    },
    // Deterministic "turn finished" wait: own slot left the room conversation
    // and no reply is in flight. Pair with a provider-call count when the turn
    // must actually have reached the executor.
    async waitSlotDone(timeout = 30000) {
      await page.waitForFunction(async roomId => {
        try {
          const state = await (await fetch(`/api/world-room/${roomId}/state`)).json();
          return !state.conversationView?.slot && !state.conversationView?.busy;
        } catch { return false; }
      }, ROOM_ID, { timeout });
    },
    async state() {
      return page.evaluate(async roomId => (await fetch(`/api/world-room/${roomId}/state`)).json(), ROOM_ID);
    },
    // The on-screen handoff button was removed (#121); operators open ?handoff.
    async handoff({ expectError = false } = {}) {
      await page.goto(stack.origin + '/?handoff', { waitUntil: 'domcontentloaded' });
      if (expectError) {
        await page.getByRole('button', { name: 'もう一度確認する', exact: true }).waitFor({ timeout: 20000 });
        return;
      }
      await page.locator('.public-exhibition-welcome').waitFor({ timeout: 20000 });
    },
    async retryHandoff() {
      await page.getByRole('button', { name: 'もう一度確認する', exact: true }).click();
      await page.locator('.public-exhibition-welcome').waitFor({ timeout: 20000 });
    },
    async micOn() {
      await page.getByRole('button', { name: /^マイクで話す/ }).click();
      await page.waitForFunction(
        () => {
          const state = document.querySelector('.public-controls__microphone')?.dataset.state;
          return state && !['off', 'starting'].includes(state);
        }, null, { timeout: 25000 });
    },
    async micSegment(holdMs = 800) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } })));
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: true } })));
      await page.waitForTimeout(holdMs);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } })));
    },
    async close() { await context.close(); },
  };
  return client;
}

export async function screenshot(client, output, name) {
  await mkdir(output, { recursive: true });
  await client.page.screenshot({ path: resolve(output, `${client.name}-${name}.png`) }).catch(() => {});
}
