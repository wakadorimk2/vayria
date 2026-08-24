import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createConversationRouter,
  createInitialRouterSnapshot,
  reduceRouter,
} from '../src/router/conversationRouter.js';
import type { RouterEvent } from '../src/router/routerTypes.js';
import {
  appendRouterEvent,
  MAX_ROUTER_EVENT_BYTES,
  readRouterEvent,
  readRouterEvents,
} from '../server/routerStore.js';

function makeEvent(): RouterEvent {
  return createConversationRouter({
    sessionId: 'rt-store-test',
    now: Date.parse('2026-08-23T00:00:00.000Z'),
  }).dispatch({ type: 'case_start', caseId: 'interruption' }).event;
}

test('Router keeps control state and both lanes orthogonal', () => {
  const initial = createInitialRouterSnapshot('rt-reducer-test', 1_000);
  const started = reduceRouter(
    initial,
    { type: 'signal', signal: { type: 'gpt_status', lane: 'speaking' }, at: 1_100 },
  );
  assert.equal(started.snapshot.controlState, 'idle');
  assert.equal(started.snapshot.gptLane, 'speaking');
  assert.equal(started.snapshot.vayriaLane, 'idle');

  const vayriaSpeaking = reduceRouter(
    started.snapshot,
    {
      type: 'signal',
      signal: {
        type: 'vayria_status',
        status: 'speaking',
        voiceInputEnabled: true,
      },
      at: 1_200,
    },
  );
  assert.equal(vayriaSpeaking.snapshot.vayriaLane, 'speaking');
  assert.equal(vayriaSpeaking.snapshot.gptLane, 'speaking');
  assert.equal(vayriaSpeaking.snapshot.controlState, 'idle');
});

test('Router commands control the Vayria stop effect and GPT input gate', () => {
  const router = createConversationRouter({ sessionId: 'rt-command-test', now: 1_000 });
  const stopVayria = router.dispatch({ type: 'stop_vayria' }, 1_100);
  assert.equal(stopVayria.snapshot.controlState, 'interrupting');
  assert.equal(stopVayria.snapshot.vayriaOutputGate, 'closed');
  assert.ok(stopVayria.effects.some((effect) => effect.type === 'interrupt_vayria'));

  const stopGpt = router.dispatch({ type: 'stop_gpt_lane' }, 1_200);
  assert.equal(stopGpt.snapshot.gptInputGate, 'closed');
  assert.ok(
    stopGpt.effects.some(
      (effect) => effect.type === 'set_gpt_input_gate' && effect.gate === 'closed',
    ),
  );
  assert.equal(stopGpt.event.event, 'control_applied');

  const blocked = router.observe(
    { type: 'gpt_audio', event: 'speech_started' },
    1_300,
  );
  assert.equal(blocked.event.event, 'gate_blocked');
  assert.equal(blocked.snapshot.metrics.gateBlockedCount, 1);
});

test('take floor pauses autonomous processing and let continue uses cooldown', () => {
  const router = createConversationRouter({ sessionId: 'rt-floor-test', now: 1_000 });
  const takeFloor = router.dispatch({ type: 'take_floor' }, 1_100);
  assert.equal(takeFloor.snapshot.controlState, 'human_override');
  assert.ok(
    takeFloor.effects.some(
      (effect) =>
        effect.type === 'set_autonomous_enabled' && effect.enabled === false,
    ),
  );

  const resume = router.dispatch({ type: 'let_continue' }, 2_000);
  assert.equal(resume.snapshot.controlState, 'cooldown');
  assert.equal(resume.snapshot.cooldownUntil, 2_500);
  assert.ok(
    resume.effects.some(
      (effect) =>
        effect.type === 'set_autonomous_enabled' && effect.enabled === false,
    ),
  );

  const completed = router.tick(2_500);
  assert.equal(completed.snapshot.controlState, 'idle');
  assert.equal(completed.snapshot.cooldownUntil, null);
  assert.equal(completed.snapshot.metrics.cooldownMs, 500);
  assert.ok(
    completed.effects.some(
      (effect) =>
        effect.type === 'set_autonomous_enabled' && effect.enabled === true,
    ),
  );
});

test('Router records turns, interruption decisions, and backchannel repetition without transcript', () => {
  const router = createConversationRouter({ sessionId: 'rt-metrics-test', now: 1_000 });
  router.observe({ type: 'voice_input', event: 'speech_started' }, 1_100);
  router.observe({ type: 'voice_input', event: 'utterance_finalized' }, 1_250);
  const interruption = router.observe(
    { type: 'barge_in_decision', accepted: true },
    1_250,
  );
  assert.equal(interruption.snapshot.metrics.turnCount, 1);
  assert.equal(interruption.snapshot.metrics.confirmedInterruptions, 1);
  assert.equal(interruption.snapshot.metrics.interruptionLatencyMs, 150);

  router.observe(
    { type: 'interaction_action', action: 'backchannel', backchannelCue: 'un' },
    2_000,
  );
  const repeated = router.observe(
    { type: 'interaction_action', action: 'backchannel', backchannelCue: 'un' },
    2_500,
  );
  assert.equal(repeated.snapshot.metrics.backchannelRepetitions, 1);
  assert.equal('text' in repeated.event, false);
  assert.equal('audio' in repeated.event, false);
  assert.equal('prompt' in repeated.event, false);
  assert.equal('history' in repeated.event, false);
  assert.equal('command' in repeated.event, false);
  assert.equal('deviceId' in repeated.event, false);
});

test('Router event store enforces allowlist, forbidden fields, size, and JSONL path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-router-'));
  try {
    const event = makeEvent();
    assert.deepEqual(readRouterEvent({ record: event }), event);
    await appendRouterEvent(root, event);
    assert.deepEqual(await readRouterEvents(root, event.sessionId), [event]);

    const stored = await readFile(
      join(root, 'router', event.sessionId, 'events.jsonl'),
      'utf8',
    );
    assert.equal(stored.includes('command'), false);
    assert.equal(stored.includes('text'), false);
    assert.equal(stored.includes('prompt'), false);
    assert.equal(MAX_ROUTER_EVENT_BYTES, 16 * 1024);

    for (const forbiddenKey of [
      'text',
      'recognizedText',
      'audio',
      'prompt',
      'history',
      'command',
      'deviceId',
      'apiKey',
      'openaiApiKey',
    ]) {
      assert.throws(
        () => readRouterEvent({ ...event, [forbiddenKey]: 'must-not-save' }),
        /Router event is invalid/,
      );
    }
    assert.throws(
      () => readRouterEvent({ ...event, reason: 'x'.repeat(121) }),
      /Router event is invalid/,
    );
    assert.throws(
      () => readRouterEvent({ ...event, reason: 'transcript must-not-save' }),
      /Router event is invalid/,
    );
    assert.throws(
      () => readRouterEvent({ ...event, sessionId: '../escape' }),
      /Router event is invalid/,
    );
    assert.throws(
      () => readRouterEvent({ ...event, padding: 'not-allowed' }),
      /Router event is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
