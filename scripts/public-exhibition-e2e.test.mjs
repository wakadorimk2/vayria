// Exhibition-mode E2E against the real stack: dist-public + Edge + Miniflare
// (real worker, SQLite PublicUsage/WorldRoom DOs, WorldExecution entrypoint).
// Provider failures are injected through the Miniflare outboundService mock.
// Run with: npm run test:e2e:exhibition
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startStack, launchBrowser, newClient, screenshot, ROOM_ID } from './public-exhibition-e2e.mjs';

const output = resolve('.project-view/exhibition-e2e');
const stack = await startStack();
const browser = await launchBrowser();
let eventSeq = 0;

after(async () => { await browser.close().catch(() => {}); await stack.dispose().catch(() => {}); });

const noErrors = client => assert.deepEqual(client.errors, [], `page errors on ${client.name}`);

async function makeExhibition(budget = 1_000_000_000) {
  const event = `e2e-${Date.now().toString(36)}-${eventSeq++}`;
  await stack.admin({ op: 'exhibition-create', event, starts: Date.now() - 60000, expires: Date.now() + 3600000, budget });
  return event;
}
async function makeClient(event, { host = true } = {}) {
  const { code } = await stack.admin({ op: 'exhibition-code', event });
  const client = await newClient(browser, stack, { name: `c${eventSeq}-${Math.random().toString(36).slice(2, 6)}` });
  await client.enroll(code);
  if (host) {
    const links = await stack.admin({ op: 'world-create', roomId: ROOM_ID });
    await client.page.goto(links.hostUrl, { waitUntil: 'domcontentloaded' });
    await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 20000 });
  }
  await client.waitWorldConnected();
  return client;
}
async function worldState(client) {
  return client.page.evaluate(async roomId => (await fetch(`/api/world-room/${roomId}/state`)).json(), ROOM_ID);
}

test('baseline: enrollment, shared text conversation, handoff, next visitor', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    const socket = await client.waitWorldSocket();
    assert.ok(!socket.isClosed());
    await client.say('こんにちは');
    assert.ok(stack.providers.count('responses') >= 1);
    assert.ok(stack.providers.count('aivis') >= 1, 'shared reply speech stored through the executor');
    await client.handoff();
    // After handoff the device must accept the next participant immediately.
    // A card insert reserves a card-reaction turn, so speak first here.
    await client.waitWorldConnected();
    await client.say('次の方です');
    await client.insertCard();
    noErrors(client);
    assert.deepEqual(client.external, []);
  } finally {
    await screenshot(client, output, 'baseline');
    await client.close();
  }
});

test('session and room membership survive a reload', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    await client.say('リロード前');
    const socketsBefore = client.worldSocketCount();
    await client.page.reload({ waitUntil: 'domcontentloaded' });
    await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 20000 });
    await client.waitWorldConnected();
    await client.waitWorldSocket();
    assert.ok(client.worldSocketCount() > socketsBefore, 'world socket reconnected after reload');
    await client.say('リロード後');
    noErrors(client);
  } finally {
    await screenshot(client, output, 'reload');
    await client.close();
  }
});

test('LLM 500 does not stall the queue; the next input still answers', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    stack.providers.set('responses', 'error');
    const calls = stack.providers.count('responses');
    await client.sendText('失敗する入力');
    while (stack.providers.count('responses') === calls) await new Promise(done => setTimeout(done, 50));
    await client.waitSlotDone();
    stack.providers.set('responses', 'ok');
    await client.say('復帰の入力');
    noErrors(client);
  } finally {
    stack.providers.set('responses', 'ok');
    await screenshot(client, output, 'llm-500');
    await client.close();
  }
});

test('LLM hang then disconnect releases the slot and the UI stays usable', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    stack.providers.set('responses', 'hang');
    await client.sendText('応答なしの入力');
    // While the provider hangs, the card UI must remain operable.
    await client.insertCard();
    stack.providers.set('responses', 'ok');
    stack.providers.release();
    await client.waitSlotDone(60000);
    await client.say('解放後の入力');
    noErrors(client);
  } finally {
    stack.providers.set('responses', 'ok');
    stack.providers.release();
    await screenshot(client, output, 'llm-hang');
    await client.close();
  }
});

test('TTS failure keeps the text reply and never wedges playback', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    stack.providers.set('aivis', 'error');
    await client.sendText('音声なしの返答');
    const caption = client.page.locator('.shared-conversation-caption').filter({ hasText: '「音声なしの返答」への返答です。' });
    await caption.waitFor({ timeout: 30000 });
    await caption.locator('small').filter({ hasText: '音声を再生できませんでした。' }).waitFor();
    stack.providers.set('aivis', 'ok');
    await client.say('音声ありの返答');
    noErrors(client);
  } finally {
    stack.providers.set('aivis', 'ok');
    await screenshot(client, output, 'tts-failure');
    await client.close();
  }
});

test('transcribe failure leaves the microphone and conversation usable', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    await client.micOn();
    stack.providers.set('transcribe', 'error');
    const calls = stack.providers.count('transcribe');
    await client.micSegment();
    while (stack.providers.count('transcribe') === calls) await new Promise(done => setTimeout(done, 50));
    await client.waitSlotDone(60000);
    stack.providers.set('transcribe', 'ok');
    const state = await client.page.evaluate(() => document.querySelector('.public-controls__microphone')?.dataset.state);
    assert.ok(state && state !== 'error' && state !== 'off', `microphone state ${state}`);
    await client.say('音声障害のあと');
    noErrors(client);
  } finally {
    stack.providers.set('transcribe', 'ok');
    await screenshot(client, output, 'stt-failure');
    await client.close();
  }
});

test('voice input reaches the shared conversation through the real audio path', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    await client.micOn();
    await client.micSegment(1200);
    await client.waitReply('「模擬の音声入力です」への返答です。', 60000);
    noErrors(client);
  } finally {
    await screenshot(client, output, 'voice');
    await client.close();
  }
});

test('network offline drops the world socket, reconnect resynchronizes', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    await client.waitWorldSocket();
    const socket = await client.waitWorldSocket();
    const before = client.worldSocketCount();
    await client.context.setOffline(true);
    // Whether the browser severs an established WebSocket under offline
    // emulation is engine-specific; what the exhibition needs is a working
    // session once connectivity returns.
    const closeDeadline = Date.now() + 10000;
    while (Date.now() < closeDeadline && client.worldSockets.every(s => !s.isClosed())) {
      await new Promise(done => setTimeout(done, 100));
    }
    const dropped = client.worldSockets.some(s => s.isClosed());
    await client.context.setOffline(false);
    if (dropped) {
      const reconnectDeadline = Date.now() + 45000;
      while (Date.now() < reconnectDeadline && client.worldSocketCount() === before) {
        await new Promise(done => setTimeout(done, 100));
      }
      assert.ok(client.worldSocketCount() > before, 'world socket reconnected');
    } else {
      assert.ok(!socket.isClosed(), 'world socket stays usable when the browser keeps it');
    }
    await client.waitWorldConnected();
    await client.say('再接続の入力');
    noErrors(client);
  } finally {
    await client.context.setOffline(false).catch(() => {});
    await screenshot(client, output, 'reconnect');
    await client.close();
  }
});

test('failed handoff persists the same requestId and retries after reload', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    const handoffs = [];
    await client.page.route('**/api/exhibition/next', route => {
      handoffs.push(route.request().postDataJSON());
      return route.continue();
    });
    await client.context.setOffline(true);
    await client.page.getByRole('button', { name: '体験を終える', exact: true }).click();
    await client.page.getByRole('button', { name: 'もう一度確認する', exact: true }).waitFor({ timeout: 20000 });
    await client.context.setOffline(false);
    await client.page.reload({ waitUntil: 'domcontentloaded' });
    // A pending handoff retries automatically on load and reuses the requestId.
    await client.page.locator('.public-exhibition-welcome').waitFor({ timeout: 30000 });
    assert.ok(handoffs.length >= 2, `expected retried handoff, got ${handoffs.length}`);
    const first = handoffs[0];
    assert.ok(handoffs.every(h => h.requestId === first.requestId), 'same requestId across retries');
    await client.say('交代後の入力');
    noErrors(client);
  } finally {
    await client.context.setOffline(false).catch(() => {});
    await screenshot(client, output, 'handoff-retry');
    await client.close();
  }
});

test('rapid card taps are rate-limited without deadlocking the table', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    await client.openCards();
    for (let i = 0; i < 15; i++) {
      await client.page.locator('.card-zone--hand [data-hand-card]').first().click({ force: true }).catch(() => {});
      await client.page.locator('.card-zone--brain [data-world-slot]').nth(i % 5).click({ force: true }).catch(() => {});
    }
    // Whatever the limiter did, a fresh insert must succeed shortly after.
    await client.page.waitForTimeout(1500);
    await client.insertCard();
    noErrors(client);
  } finally {
    await screenshot(client, output, 'card-burst');
    await client.close();
  }
});

test('repeated handoff presses collapse into one transition', async () => {
  const client = await makeClient(await makeExhibition());
  try {
    const handoffs = [];
    await client.page.route('**/api/exhibition/next', route => {
      handoffs.push(route.request().postDataJSON());
      return route.continue();
    });
    // Fire three presses inside one JS turn so they race within a single
    // handoff; IPC-spaced clicks can land on the remounted button instead.
    await client.page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === '体験を終える');
      for (let i = 0; i < 3; i++) button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await client.page.locator('.public-exhibition-welcome').waitFor({ timeout: 20000 });
    assert.equal(new Set(handoffs.map(h => h.requestId)).size, handoffs.length === 0 ? 0 : 1);
    assert.ok(handoffs.length >= 1);
    noErrors(client);
  } finally {
    await screenshot(client, output, 'handoff-spam');
    await client.close();
  }
});

test('guest card inserts propagate to the host; shared reply reaches both', async () => {
  const event = await makeExhibition();
  const host = await makeClient(event);
  const guest = await newClient(browser, stack, { name: 'guest' });
  try {
    await guest.open('/');
    await guest.waitWorldConnected();
    const before = (await worldState(host)).sequence;
    await guest.openCards();
    await guest.page.locator('.card-zone--hand [data-hand-card]').first().click({ force: true });
    await guest.page.locator('.card-zone--brain [data-world-slot]').first().click({ force: true });
    await guest.page.locator('.shared-world-receipt').filter({ hasText: '受け付けました' }).waitFor({ timeout: 10000 });
    const deadline = Date.now() + 15000;
    let after = before;
    while (Date.now() < deadline && after <= before) {
      await new Promise(done => setTimeout(done, 200));
      after = (await worldState(host)).sequence;
    }
    assert.ok(after > before, 'host observed the guest insert');
    await host.say('みんな見えてる');
    await guest.page.locator('.shared-conversation-caption').filter({ hasText: '「みんな見えてる」への返答です。' }).first().waitFor({ timeout: 30000 });
    noErrors(host);
    noErrors(guest);
  } finally {
    await screenshot(host, output, 'host-guest');
    await screenshot(guest, output, 'guest');
    await host.close();
    await guest.close();
  }
});

test('a second exhibition device takes over the host lease', async () => {
  const event = await makeExhibition();
  const first = await makeClient(event);
  const second = await makeClient(event);
  try {
    const initial = (await worldState(first)).host?.clientId;
    assert.ok(initial, 'first device holds the lease');
    // The second device sees the conflict notice and the takeover affordance.
    await second.openCards();
    await second.page.getByRole('button', { name: 'この端末へ展示を引き継ぐ', exact: true }).waitFor({ timeout: 15000 });
    await second.page.getByRole('button', { name: 'この端末へ展示を引き継ぐ', exact: true }).click();
    const deadline = Date.now() + 15000;
    let holder = initial;
    while (Date.now() < deadline && holder === initial) {
      await new Promise(done => setTimeout(done, 200));
      holder = (await worldState(second)).host?.clientId;
    }
    assert.notEqual(holder, initial, 'lease moved to the second device');
    await second.say('引き継ぎ後の入力');
    noErrors(first);
    noErrors(second);
  } finally {
    await screenshot(first, output, 'takeover-old');
    await screenshot(second, output, 'takeover-new');
    await first.close();
    await second.close();
  }
});

test('operator reset sweeps every client to a fresh epoch', async () => {
  const event = await makeExhibition();
  const host = await makeClient(event);
  const guest = await newClient(browser, stack, { name: 'guest-reset' });
  try {
    await guest.open('/');
    await guest.waitWorldConnected();
    await host.insertCard();
    const before = await worldState(host);
    await stack.admin({ op: 'world-control', roomId: ROOM_ID, action: 'reset' });
    const deadline = Date.now() + 15000;
    let next = before;
    while (Date.now() < deadline && next.epoch === before.epoch) {
      await new Promise(done => setTimeout(done, 200));
      next = await worldState(guest);
    }
    assert.ok(next.epoch > before.epoch, 'guest observed the new epoch');
    assert.equal(Object.keys(next.weights ?? {}).length, 0, 'world weights cleared');
    // The room refuses writes during the reset sweep window.
    const sweepDeadline = Date.now() + 10000;
    let swept = next;
    while (Date.now() < sweepDeadline && swept.resetUntil && swept.resetUntil > swept.serverNow) {
      await new Promise(done => setTimeout(done, 200));
      swept = await worldState(host);
    }
    await host.insertCard();
    noErrors(host);
    noErrors(guest);
  } finally {
    await screenshot(host, output, 'reset');
    await host.close();
    await guest.close();
  }
});

test('exhibition stop pauses the device and blocks new conversations', async () => {
  const event = await makeExhibition();
  const client = await makeClient(event);
  try {
    await client.say('停止前の入力');
    await stack.admin({ op: 'exhibition-stop', event });
    await client.page.locator('.public-exhibition-paused').waitFor({ timeout: 25000 });
    const calls = stack.providers.count('responses');
    await client.sendText('停止後の入力').catch(() => {});
    await client.page.waitForTimeout(3000);
    assert.equal(stack.providers.count('responses'), calls, 'no provider call after stop');
    noErrors(client);
  } finally {
    await screenshot(client, output, 'exhibition-stop');
    await client.close();
  }
});

test('exhausted budget fails the turn but leaves the exhibition responsive', async () => {
  const client = await makeClient(await makeExhibition(1));
  try {
    await client.sendText('予算不足の入力');
    await client.waitSlotDone(60000);
    // The card path does not depend on the conversation budget.
    await client.insertCard();
    noErrors(client);
  } finally {
    await screenshot(client, output, 'budget');
    await client.close();
  }
});

test('image generation failure marks the element failed and keeps the room alive', async (t) => {
  // The production-shaped stack disables MANIFESTATION, so spin a second stack
  // with the generation path enabled to exercise the failure end to end.
  const visual = await startStack({ env: { MANIFESTATION_ENABLED: 'true', FAL_KEY: 'e2e-fal-key' } });
  const event = `e2e-visual-${Date.now().toString(36)}`;
  try {
    await visual.admin({ op: 'exhibition-create', event, starts: Date.now() - 60000, expires: Date.now() + 3600000, budget: 1_000_000_000 });
    const { code } = await visual.admin({ op: 'exhibition-code', event });
    const client = await newClient(browser, visual, { name: 'visual' });
    try {
      await client.enroll(code);
      const links = await visual.admin({ op: 'world-create', roomId: ROOM_ID });
      await client.page.goto(links.hostUrl, { waitUntil: 'domcontentloaded' });
      await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 20000 });
      await client.waitWorldConnected();
      // Enable the generation mode on the device, then make the provider fail.
      await client.page.locator('.public-controls__generation').click();
      visual.providers.set('fal', 'error');
      visual.providers.setWorldIntent(({ brainCardIds }) => ({
        actions: brainCardIds.length
          ? [{ type: 'prop', concept: 'crab', targetId: '', sourceCardIds: brainCardIds.slice(0, 1), effects: [], count: 1 }]
          : [],
      }));
      await client.insertCard();
      await client.say('カニを出して');
      const deadline = Date.now() + 90000;
      let failed = false;
      while (Date.now() < deadline && !failed) {
        const state = await client.page.evaluate(async roomId => (await fetch(`/api/world-room/${roomId}/state`)).json(), ROOM_ID);
        failed = (state.elements ?? []).some(e => e.status === 'failed');
        if (!failed) await new Promise(done => setTimeout(done, 500));
      }
      assert.ok(failed, 'element marked failed after provider error');
      await client.say('失敗のあとも');
      noErrors(client);
    } finally {
      await screenshot(client, output, 'visual-failure');
      await client.close();
    }
  } finally {
    visual.providers.release();
    await visual.dispose().catch(() => {});
  }
});
