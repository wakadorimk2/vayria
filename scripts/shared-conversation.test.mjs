import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile('src/conversation/sharedConversation.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { SharedConversationQueue, resemblesPlayback } = await import('data:text/javascript,' + encodeURIComponent(code));

test('room speech waits for quiet, batches text, and never repeats a consumed decision', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const sent = []; const q = new SharedConversationQueue(text => sent.push(text), () => assert.fail('overflow'));
  q.speechStarted(); q.speechEnded(); q.append('雨の日は何する？');
  t.mock.timers.tick(500); q.speechStarted(); t.mock.timers.tick(1000);
  assert.deepEqual(sent, []);
  q.speechEnded(); q.append('ゲームかな'); t.mock.timers.tick(899); assert.equal(sent.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(sent, ['雨の日は何する？\nゲームかな']);
  t.mock.timers.tick(10000); assert.equal(sent.length, 1); q.reset();
});
test('reset cancels pending room speech and overflow is surfaced', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const sent = []; let overflow = 0;
  const q = new SharedConversationQueue(text => sent.push(text), () => overflow++);
  q.speechEnded(); q.append('前の参加者'); q.reset(); t.mock.timers.tick(1000); assert.equal(sent.length, 0);
  q.speechStarted(); for (let i = 0; i < 5; i++) q.append('発話');
  assert.equal(overflow, 1); q.speechEnded(); t.mock.timers.tick(1000); assert.equal(sent.length, 0);
});
test('echo hint accepts an exact playback fragment but preserves additional human content', () => {
  assert(resemblesPlayback('雨の日はゲーム。', '私は雨の日はゲームかな。'));
  assert(!resemblesPlayback('雨の日はゲーム？ 私は映画だよ', '雨の日はゲーム。'));
  assert(!resemblesPlayback('はい', 'はい、そうです。'));
});
