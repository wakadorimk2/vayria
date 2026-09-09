// Optional local browser check. Uses a built public app and mocked APIs; never calls paid providers.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const mount = process.env.VAYRIA_CHECK_BASE_PATH ?? '';
if (!['', '/staging'].includes(mount)) throw new Error('Invalid browser check base');
const root = resolve('dist-public'), output = resolve(mount ? '.project-view/staging-check' : '.project-view/exhibition-check');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const selectedRoot = mount && !pathname.startsWith(mount + '/') ? resolve('.wrangler/root-build') : root;
  const relative = mount && pathname.startsWith(mount + '/') ? pathname.slice(mount.length) : pathname;
  const file = resolve(selectedRoot, '.' + (/^\/exhibition\/?$/.test(relative) ? '/' : relative));
  if (file !== selectedRoot && !file.startsWith(selectedRoot + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const content = await readFile(file === selectedRoot ? resolve(selectedRoot, 'index.html') : file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || (file === selectedRoot ? 'text/html' : 'application/octet-stream'));
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, permissions: ['microphone'] });
let enrolled = true;
let epoch = 1, session = null, failHandoff = false, failStatus = false, usedYen = 0, handoffs = [], generations = [], microphoneAcquisitions = 0;
let delayedReply;
let delayManual = true;
let releaseSharedReply;
const replyGate = new Promise(done => { delayedReply = done; });
const wav = Buffer.alloc(44 + 16000 * 5 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const exhibition = () => ({ id: 'test', epoch, starts: Date.now() - 10000, expires: Date.now() + 3600000,
  budgetYen: 10000, usedYen, warning: usedYen >= 8000 ? '80' : usedYen >= 5000 ? '50' : null, available: true, revoked: false, stopped: false });
const status = () => ({ cookieReady: true, enabled: true, siteKey: 'mock', stopped: false, remainingDay: 2, remainingMonth: 10, exhibition: enrolled ? exhibition() : null, session });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
await page.exposeFunction('recordMicrophone', () => { microphoneAcquisitions++; });
await page.addInitScript(() => {
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.exhibitTracks = [];
  window.exhibitSources = [];
  const createSource = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    const source = createSource.call(this), record = { started: false, stopped: false, ended: false };
    window.exhibitSources.push(record);
    const start = source.start.bind(source), stop = source.stop.bind(source);
    source.start = (...args) => { record.started = true; return start(...args); };
    source.stop = (...args) => { record.stopped = true; return stop(...args); };
    source.addEventListener('ended', () => { record.ended = true; });
    return source;
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.recordMicrophone(); const stream = await capture(constraints);
    window.exhibitTracks.push(...stream.getTracks()); return stream;
  };
});
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) { await route.abort(); return; }
  if (mount && url.pathname.startsWith('/api/')) throw new Error('Staging requested production API: ' + url.pathname);
  if (mount && url.pathname.startsWith(mount + '/')) url.pathname = url.pathname.slice(mount.length);
  if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
  const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/session') {
    if (request.method() === 'POST') { session = { id: `session-${epoch}`, expires: Date.now() + 3600000 }; return json(status()); }
    if (failStatus) return json({ code: 'service_unavailable' }, 503);
    return json(status());
  }
  if (url.pathname === '/api/exhibition/enroll') { enrolled = true; return json(status()); }
  if (url.pathname === '/api/exhibition/next') {
    const input = request.postDataJSON(); handoffs.push(input);
    if (failHandoff) return json({ code: 'network_error' }, 503);
    epoch++; session = null; return json(status());
  }
  if (['/api/chat', '/api/card-preview', '/api/transcribe', '/api/tts'].includes(url.pathname)) {
    generations.push({ path: url.pathname, body: request.postData() });
    if (url.pathname === '/api/tts') return route.fulfill({ contentType: 'audio/wav', body: wav });
    if (url.pathname === '/api/chat') {
      const input = request.postDataJSON();
      if (input.mode === 'autonomous') return json({ code: 'generation_failed' }, 503);
      if (delayManual) await replyGate;
      if (input.message === '判断中の交代') await new Promise(done => { releaseSharedReply = done; });
      if (input.message === 'うん') return json({ interactionAction: 'listen', backchannelCue: 'none', text: '', emotion: 'neutral', activatedCards: [], speechAct: null, expressionLevel: null });
      return json({ interactionAction: 'take_floor', backchannelCue: 'none', text: '模擬の返答です。', emotion: 'neutral',
        activatedCards: [input.brainCardIds[0]], speechAct: 'answer', expressionLevel: 'low', internalDelta: { reasonUpdates: [] }, ttsTicket: 'mock-ticket' }).catch(() => {});
    }
    return json({ code: 'generation_failed' }, 503).catch(() => {});
  }
  return json({ code: 'not_found' }, 404);
});
try {
  await page.goto(base + mount + '/');
  await page.getByRole('button', { name: '体験を終える', exact: true }).waitFor();
  await page.waitForTimeout(5000);
  assert.equal(generations.length, 0, JSON.stringify(generations)); assert.equal(microphoneAcquisitions, 0);
  const initialCards = await page.locator('.card-zone--brain [data-card-id]').evaluateAll(nodes => nodes.map(n => n.dataset.cardId));
  await page.screenshot({ path: resolve(output, 'ipad-portrait.png') });
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.screenshot({ path: resolve(output, 'ipad-landscape.png') });
  const tapCard = async selector => {
    const box = await page.locator(selector).first().boundingBox(); assert.ok(box);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  await page.getByRole('button', { name: 'カードで遊ぶ', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'cards-landscape.png') });
  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.screenshot({ path: resolve(output, 'cards-portrait.png') });
  await page.setViewportSize({ width: 1366, height: 1024 });
  await tapCard('.card-zone--hand [data-card-id]');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/chat')), tapCard('.card-zone--brain [data-card-id]')]);
  assert.ok(generations.some(g => g.path === '/api/chat' && JSON.parse(g.body).mode === 'autonomous' && JSON.parse(g.body).forcedCardId));
  assert.notDeepEqual(await page.locator('.card-zone--brain [data-card-id]').evaluateAll(nodes => nodes.map(n => n.dataset.cardId)), initialCards);
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByText('次の方もカードからどうぞ', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.card-zone--brain [data-card-id]').evaluateAll(nodes => nodes.map(n => n.dataset.cardId)), initialCards);
  await page.getByRole('button', { name: '文字で話す', exact: true }).click();
  const input = page.locator('.message-form input');
  await input.fill('前の参加者の入力');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-form button[type="submit"]')?.disabled === true);
  failHandoff = true;
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByRole('button', { name: 'もう一度確認する' }).waitFor();
  assert.equal(await page.locator('.app-shell').count(), 0);
  const first = handoffs.at(-1);
  await page.screenshot({ path: resolve(output, 'handoff-offline.png') });
  await page.reload();
  await page.getByRole('button', { name: 'もう一度確認する' }).waitFor();
  assert.deepEqual(handoffs.at(-1), first);
  failHandoff = false;
  await page.getByRole('button', { name: 'もう一度確認する' }).click();
  await page.getByText('次の方もカードからどうぞ', { exact: true }).waitFor();
  delayedReply();
  delayManual = false;
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.locator('.card-zone--brain [data-card-id]').evaluateAll(nodes => nodes.map(n => n.dataset.cardId)), initialCards);
  await page.getByRole('button', { name: '文字で話す', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  await input.fill('音声再生の停止を確認');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.waitForFunction(() => window.exhibitSources.some(s => s.started && !s.stopped && !s.ended));
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByText('次の方もカードからどうぞ', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.exhibitSources.filter(s => s.started).every(s => s.stopped || s.ended)), true);
  await page.getByRole('button', { name: '文字で話す', exact: true }).click();
  await page.getByRole('button', { name: '文字で話す', exact: true }).click();
  // Real browser capture of a fake microphone; stopping must end every acquired track.
  await page.getByRole('button', { name: /^マイクで話す/ }).click();
  await page.waitForFunction(() => window.exhibitTracks.length > 0);
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByText('次の方もカードからどうぞ', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.exhibitTracks.every(t => t.readyState === 'ended')), true);
  await page.getByRole('button', { name: '挨拶してみる', exact: true }).click();
  await page.getByText('文字・マイク・カードから続けられます', { exact: true }).waitFor();
  assert.ok(generations.some(g => g.path === '/api/chat' && JSON.parse(g.body).greeting === true));
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByRole('button', { name: '挨拶してみる', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'カードで遊ぶ', exact: true }).getAttribute('aria-expanded'), 'false');
  // Shared conversation remains a setting, independent of registration and its budget.
  const openSettings = async () => { await page.getByRole('button', { name: '設定', exact: true }).click(); };
  await openSettings();
  await page.getByLabel('会話設定').selectOption('exhibition');
  await page.getByText('三者会話の操作・音声比較', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.public-conversation-tools button')?.disabled === false, null, { timeout: 90000 });
  assert.equal(await page.getByRole('button', { name: '次の参加者へ', exact: true }).count(), 0);
  for (const size of [{ width: 1024, height: 1366 }, { width: 1366, height: 1024 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(output, `shared-settings-${size.width}.png`) });
    const panel = await page.locator('#public-session-panel').boundingBox();
    assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= size.width);
  }
  await page.getByRole('button', { name: '音声をミュートする', exact: true }).click();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '文字で話す', exact: true }).click();
  await page.getByLabel('入力の宛先').selectOption('room');
  const sendRoom = async text => {
    await input.fill(text);
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await page.waitForResponse(r => r.url().endsWith('/api/chat'));
  };
  await sendRoom('うん');
  await page.waitForTimeout(300);
  const ttsBefore = generations.filter(g => g.path === '/api/tts').length;
  await sendRoom('どう思う？');
  await page.locator('.conversation .reply').filter({ hasText: '模擬の返答です。' }).waitFor();
  const sharedRequest = JSON.parse(generations.filter(g => g.path === '/api/chat').at(-1).body);
  assert.equal(sharedRequest.programContext.participantRole, 'shared_microphone_group');
  assert.equal(sharedRequest.streamSpeech, false);
  assert.ok(sharedRequest.history.some(h => h.content === 'うん'));
  assert.equal(generations.filter(g => g.path === '/api/tts').length, ttsBefore);
  await openSettings();
  await page.getByRole('button', { name: 'Vayriaに振る', exact: true }).click();
  await page.waitForResponse(r => r.url().endsWith('/api/chat'));
  assert.equal(JSON.parse(generations.filter(g => g.path === '/api/chat').at(-1).body).mode, 'voice');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await input.fill('判断中の交代');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.waitForRequest(r => r.url().endsWith('/api/chat'));
  await page.getByRole('button', { name: '体験を終える', exact: true }).click();
  await page.getByText('次の方もカードからどうぞ', { exact: true }).waitFor();
  releaseSharedReply?.();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('.conversation .reply').count(), 0);
  assert.equal(await page.evaluate(() => window.exhibitTracks.every(t => t.readyState === 'ended')), true);
  await openSettings();
  assert.equal(await page.getByLabel('会話設定').inputValue(), 'exhibition');
  await page.getByLabel('会話設定').selectOption('normal');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  usedYen = 8000;
  await page.waitForTimeout(16000);
  await page.getByRole('button', { name: '設定：展示予算の通知あり', exact: true }).click();
  await page.getByText('展示の運営', { exact: true }).click();
  await page.getByText('展示予算の80％に達しました。上限に達すると生成を停止します。', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'operator-budget.png') });
  failStatus = true;
  await page.waitForTimeout(16000);
  await page.getByText('利用状況を更新できていません。表示は最後に確認できた値です。', { exact: true }).waitFor();
  if (mount) {
    failStatus = false;
    // The root build shares this browser context but has an independent application state.
    const rootPage = await context.newPage();
    await rootPage.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cookieReady: true, enabled: false, session: null, exhibition: null }) });
      return route.continue();
    });
    await rootPage.goto(base + '/');
    await rootPage.getByRole('button', { name: '設定', exact: true }).click();
    await rootPage.getByRole('radio', { name: 'ダーク', exact: true }).check({ force: true });
    assert.equal(await rootPage.evaluate(() => localStorage.getItem('vayria-public-theme')), 'dark');
    await page.reload();
    await page.getByRole('button', { name: '設定：展示予算の通知あり', exact: true }).click();
    await page.getByRole('radio', { name: 'ライト', exact: true }).check({ force: true });
    assert.equal(await page.evaluate(() => localStorage.getItem('staging:vayria-public-theme')), 'light');
    assert.equal(await rootPage.evaluate(() => localStorage.getItem('vayria-public-theme')), 'dark');
    await page.evaluate(() => sessionStorage.setItem('vayria-exhibition-handoff', JSON.stringify({ requestId: 'production-only', epoch: 9 })));
    await page.reload();
    await page.getByRole('button', { name: '体験を終える', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('staging:vayria-exhibition-handoff')), null);
    enrolled = false;
    await page.goto(base + mount + '/exhibition');
    await page.getByRole('button', { name: 'この端末を登録', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '体験画面へ戻る' }).getAttribute('href'), mount + '/');
    await page.locator('input').fill('a'.repeat(32));
    await page.getByRole('button', { name: 'この端末を登録', exact: true }).click();
    await page.waitForURL(base + mount + '/');
    await page.getByRole('button', { name: '体験を終える', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('vayria-exhibition-handoff')).requestId), 'production-only');
    await rootPage.close();
  }
  // A non-enrolled prototype uses local reset and must also stop comparison audio.
  enrolled = false; session = null; failStatus = false;
  await page.goto(base + mount + '/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('会話設定').selectOption('exhibition');
  await page.getByText('三者会話の操作・音声比較', { exact: true }).click();
  await page.getByText('音声比較と診断', { exact: true }).click();
  await page.getByLabel('比較用の音声ファイル').setInputFiles({ name: 'comparison.wav', mimeType: 'audio/wav', buffer: wav });
  await page.getByRole('button', { name: 'マイクなしで比較再生', exact: true }).click();
  await page.waitForFunction(() => window.exhibitSources.some(s => s.started && !s.stopped && !s.ended));
  await page.getByRole('button', { name: '次の参加者へ', exact: true }).click();
  await page.getByText('新しい会話を始められます', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.exhibitSources.filter(s => s.started).every(s => s.stopped || s.ended)), true);
  assert.equal(await page.getByRole('button', { name: 'マイクなしで比較再生', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.exhibitTracks.length), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: output, checks: [...(mount ? ['same-origin-settings-isolation', 'handoff-storage-isolation', 'registration-returns-to-staging', 'no-production-api-requests'] : []), 'local-comparison-reset', 'shared-listen-history', 'shared-muted-subtitle', 'shared-handoff-invalidates-reply', 'shared-explicit-invitation', 'registered-settings-preserved', 'idle-no-generation-or-microphone', 'portrait-landscape', 'card-reaction-request-and-reset', 'handoff-failure-reload-retry', 'old-input-cleared', 'audio-playback-stopped', 'microphone-tracks-ended', 'greeting-and-panel-reset', 'budget-notice', 'stale-status'], generations: generations.length }));
} catch (error) {
  console.error(JSON.stringify({ generations, errors, ui: await page.locator('body').innerText(), sources: await page.evaluate(() => window.exhibitSources) }));
  await page.screenshot({ path: resolve(output, 'failure.png') });
  throw error;
} finally { delayedReply(); releaseSharedReply?.(); await browser.close(); await new Promise(done => server.close(done)); }
