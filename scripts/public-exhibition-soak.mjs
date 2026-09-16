// Exhibition-mode soak runner. Drives a real Edge browser against the real
// Miniflare stack with randomized actions and injected provider failures for
// SOAK_MINUTES minutes (default 30) or SOAK_TURNS turns. Stops on the first
// hard failure and dumps diagnostics (action log, console/page errors, world
// state, screenshot) under .project-view/exhibition-soak/.
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStack, launchBrowser, newClient, screenshot, ROOM_ID } from './public-exhibition-e2e.mjs';

const minutes = Number(process.env.SOAK_MINUTES ?? 30);
const maxTurns = Number(process.env.SOAK_TURNS ?? 0) || Infinity;
const output = resolve('.project-view/exhibition-soak');
mkdirSync(output, { recursive: true });
const log = resolve(output, `soak-${Date.now()}.log`);
const line = message => {
  const stamped = `${new Date().toISOString()} ${message}`;
  console.log(stamped);
  appendFileSync(log, stamped + '\n');
};

const stack = await startStack();
const browser = await launchBrowser();
const event = `soak-${Date.now().toString(36)}`;
await stack.admin({ op: 'exhibition-create', event, starts: Date.now() - 60000, expires: Date.now() + minutes * 60000 + 3600000, budget: 1_000_000_000 });
const { code } = await stack.admin({ op: 'exhibition-code', event });
const client = await newClient(browser, stack, { name: 'soak' });
const diagnostics = { turns: 0, failures: [], pageErrors: client.errors, external: client.external, actions: [] };

const random = seed => {
  let value = seed >>> 0;
  return () => ((value = (value * 1664525 + 1013904223) >>> 0) / 0x100000000);
};
const roll = random(Number(process.env.SOAK_SEED ?? Date.now() % 0xffffffff));

const action = name => diagnostics.actions.push({ name, at: new Date().toISOString() });
const fail = async (name, error) => {
  diagnostics.failures.push({ name, error: String(error), at: new Date().toISOString() });
  line(`FAIL ${name}: ${error}`);
  await screenshot(client, output, `fail-${diagnostics.turns}`);
  try { diagnostics.world = await client.state(); } catch {}
  throw error;
};

await client.enroll(code);
const links = await stack.admin({ op: 'world-create', roomId: ROOM_ID });
await client.page.goto(links.hostUrl, { waitUntil: 'domcontentloaded' });
await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 20000 });
await client.waitWorldConnected();
line(`exhibition ${event} enrolled; soaking for ${minutes}min`);

const deadline = Date.now() + minutes * 60000;
const failures = [
  ['responses', 'error'], ['responses', 'hang'], ['transcribe', 'error'],
  ['aivis', 'error'], ['aivis', 2500], ['turnstile', 'ok'],
];
const weights = [
  ['card', 25], ['text', 30], ['mic', 10], ['failure', 8],
  ['reload', 4], ['offline', 4], ['handoff', 8], ['reset', 3],
  ['stop-start', 4], ['wait', 4],
];
const pick = () => {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let hit = roll() * total;
  for (const [name, w] of weights) { hit -= w; if (hit <= 0) return name; }
  return 'text';
};

try {
  while (Date.now() < deadline && diagnostics.turns < maxTurns) {
    const name = pick();
    action(name);
    try {
      switch (name) {
        case 'card': await client.insertCard(); break;
        case 'text': {
          await client.say(`soak-${diagnostics.turns}`);
          break;
        }
        case 'mic': {
          const visible = await client.page.getByRole('button', { name: /^マイクで話す/ }).isVisible().catch(() => false);
          if (!visible) break;
          await client.micOn();
          const calls = stack.providers.count('transcribe');
          await client.micSegment(900);
          const until = Date.now() + 30000;
          while (Date.now() < until && stack.providers.count('transcribe') === calls) {
            await client.page.waitForTimeout(200);
          }
          if (stack.providers.count('transcribe') > calls) {
            await client.waitReply('「模擬の音声入力です」への返答です。', 60000);
          }
          break;
        }
        case 'failure': {
          const [provider, mode] = failures[Math.floor(roll() * failures.length)];
          stack.providers.set(provider, mode);
          const calls = stack.providers.count('responses');
          await client.sendText(`failure-${diagnostics.turns}`);
          if (mode === 'hang') {
            await client.page.waitForTimeout(2500);
            stack.providers.release();
          }
          const until = Date.now() + 60000;
          while (Date.now() < until && stack.providers.count('responses') === calls) {
            await client.page.waitForTimeout(200);
          }
          stack.providers.set(provider, 'ok');
          await client.waitSlotDone(60000);
          await client.say(`recover-${diagnostics.turns}`);
          break;
        }
        case 'reload':
          await client.page.reload({ waitUntil: 'domcontentloaded' });
          await client.waitWorldConnected();
          await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 20000 });
          break;
        case 'offline':
          await client.context.setOffline(true);
          await client.page.waitForTimeout(1500 + roll() * 3000);
          await client.context.setOffline(false);
          await client.waitWorldConnected(45000);
          break;
        case 'handoff':
          await client.handoff();
          await client.waitWorldConnected();
          break;
        case 'reset':
          await stack.admin({ op: 'world-control', roomId: ROOM_ID, action: 'reset' });
          await client.page.waitForTimeout(2000);
          break;
        case 'stop-start': {
          // exhibition-stop is terminal for the event; toggle the global
          // service switch instead so the same enrollment can resume.
          await stack.admin({ op: 'configure', stopped: true });
          await client.page.locator('.public-exhibition-paused').waitFor({ timeout: 30000 });
          await stack.admin({ op: 'configure', stopped: false });
          await client.page.getByRole('button', { name: '体験を終える', exact: true }).waitFor({ timeout: 30000 });
          break;
        }
        case 'wait':
          await client.page.waitForTimeout(1000 + roll() * 5000);
          break;
      }
    } catch (error) {
      await fail(name, error);
    }
    diagnostics.turns++;
    if (diagnostics.turns % 10 === 0) {
      const state = await client.state().catch(() => null);
      line(`turn ${diagnostics.turns} epoch=${state?.epoch} sequence=${state?.sequence} elements=${state?.elements?.length ?? '?'} errors=${client.errors.length}`);
    }
  }
  line(`completed ${diagnostics.turns} turns, ${client.errors.length} page errors`);
} catch (error) {
  line(`aborted at turn ${diagnostics.turns}: ${error}`);
  process.exitCode = 1;
} finally {
  appendFileSync(log, JSON.stringify(diagnostics, null, 2));
  await screenshot(client, output, 'final');
  await client.close().catch(() => {});
  await browser.close().catch(() => {});
  await stack.dispose().catch(() => {});
}
