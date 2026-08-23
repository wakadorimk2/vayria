import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFloorController,
  MAX_PENDING_USER_FRAGMENTS,
  MAX_PENDING_USER_TEXT_LENGTH,
  PENDING_USER_FLOOR_TTL_MS,
} from '../src/conversation/floorController.js';
import { createInteractionTimeline } from '../src/conversation/interactionTimeline.js';
import {
  createSemanticDialogueHistory,
  MAX_SEMANTIC_HISTORY_MESSAGES,
} from '../src/conversation/semanticDialogueHistory.js';

const listen = { action: 'listen' as const, backchannelCue: 'none' as const };
const backchannel = {
  action: 'backchannel' as const,
  backchannelCue: 'un' as const,
};
const takeFloor = {
  action: 'take_floor' as const,
  backchannelCue: 'none' as const,
};

function metadata(segmentId: string, at: number) {
  return { segmentId, at, asrConfidence: null };
}

test('preview and take_floor use only the current finalized utterance', () => {
  const timeline = createInteractionTimeline();
  const controller = createFloorController(timeline);

  controller.applyFinalized(
    '昨日の話だけど',
    listen,
    metadata('segment-1', 100),
  );
  controller.applyFinalized(
    '帰り道だったので',
    listen,
    metadata('segment-2', 200),
  );

  assert.equal(controller.getState(200).pendingUserFloor.length, 2);
  assert.equal(controller.preview('こんにちは', 300).candidateText, 'こんにちは');

  const transition = controller.applyFinalized(
    'こんにちは',
    takeFloor,
    metadata('segment-3', 300),
  );

  assert.equal(transition.committedText, 'こんにちは');
  assert.equal(transition.candidateText, 'こんにちは');
  assert.equal(controller.getState(300).pendingUserFloor.length, 0);
  assert.equal(controller.getState(300).floorOwner, 'vayria');
  assert.ok(
    timeline.snapshot().some(
      (event) => event.kind === 'floor_action' && event.action === 'take_floor',
    ),
  );
  assert.ok(
    timeline.snapshot().some(
      (event) =>
        event.kind === 'pending_discarded' &&
        event.reason === 'take-floor-current-utterance-only',
    ),
  );
});

test('content-bearing listen is promoted to take_floor', () => {
  const controller = createFloorController();

  const transition = controller.applyFinalized(
    'こんにちは',
    listen,
    metadata('segment-1', 100),
  );

  assert.equal(transition.action, 'take_floor');
  assert.equal(transition.committedText, 'こんにちは');
  assert.equal(controller.getState(100).pendingUserFloor.length, 0);
});

test('three finalized utterances stay independent semantic user messages', () => {
  const timeline = createInteractionTimeline();
  const controller = createFloorController(timeline);
  const utterances = ['こんにちは', '自己紹介してよ', 'こんにちは'];

  const transitions = utterances.map((text, index) =>
    controller.applyFinalized(
      text,
      takeFloor,
      metadata(`segment-${index + 1}`, (index + 1) * 100),
    ),
  );

  assert.deepEqual(
    transitions.map((transition) => transition.committedText),
    utterances,
  );
  assert.equal(
    timeline
      .snapshot()
      .filter(
        (event) => event.kind === 'floor_action' && event.action === 'take_floor',
      ).length,
    3,
  );
});

test('pure backchannel does not consume or create semantic pending context', () => {
  const controller = createFloorController();

  const transition = controller.applyFinalized(
    'うん',
    backchannel,
    metadata('segment-1', 100),
  );

  assert.equal(transition.committedText, null);
  assert.equal(controller.getState(100).pendingUserFloor.length, 0);
});

test('content-bearing backchannel is promoted to take_floor', () => {
  const controller = createFloorController();

  const transition = controller.applyFinalized(
    '今日は雨だった',
    backchannel,
    metadata('segment-1', 100),
  );

  assert.equal(transition.action, 'take_floor');
  assert.equal(transition.committedText, '今日は雨だった');
});

test('pending context expires after the configured TTL', () => {
  const timeline = createInteractionTimeline();
  const controller = createFloorController(timeline);

  controller.applyFinalized(
    '昨日の話だけど',
    listen,
    metadata('segment-1', 100),
  );
  assert.equal(
    controller.getState(100 + PENDING_USER_FLOOR_TTL_MS).pendingUserFloor.length,
    0,
  );
  assert.ok(
    timeline.snapshot().some((event) => event.kind === 'pending_expired'),
  );
});

test('pending context keeps only the newest bounded fragments', () => {
  const controller = createFloorController();

  for (let index = 0; index < MAX_PENDING_USER_FRAGMENTS + 2; index += 1) {
    controller.applyFinalized(
      `断片${index}だけど`,
      listen,
      metadata(`segment-${index}`, index * 100),
    );
  }

  const pending = controller.getState(1_000).pendingUserFloor;
  assert.equal(pending.length, MAX_PENDING_USER_FRAGMENTS);
  assert.equal(pending[0]?.text, '断片2だけど');
  assert.ok(
    pending.reduce((total, fragment) => total + fragment.text.length, 0) <=
      1_000,
  );
});

test('pending context stays within the total text limit', () => {
  const controller = createFloorController();
  const fragment = `${'あ'.repeat(400)}だけど`;

  for (let index = 0; index < MAX_PENDING_USER_FRAGMENTS; index += 1) {
    controller.applyFinalized(
      fragment,
      listen,
      metadata(`segment-${index}`, index * 100),
    );
  }

  const pending = controller.getState(300).pendingUserFloor;
  assert.ok(
    pending.reduce((total, item) => total + item.text.length, 0) <=
      MAX_PENDING_USER_TEXT_LENGTH,
  );
});

test('semantic history is turn-bounded and excludes listen/backchannel entries', () => {
  const history = createSemanticDialogueHistory(5);

  for (let index = 0; index < 6; index += 1) {
    history.commitTurn(`ユーザー${index}`, `返答${index}`, index);
  }

  const messages = history.toMessages();
  assert.equal(messages.length, MAX_SEMANTIC_HISTORY_MESSAGES);
  assert.equal(messages[0]?.content, 'ユーザー1');
  assert.equal(messages.at(-1)?.content, '返答5');
  assert.equal(
    messages.some((message) => message.content === '昨日さ'),
    false,
  );
});

test('turn signals are recorded without exposing transcript text', () => {
  const timeline = createInteractionTimeline();
  const controller = createFloorController(timeline);

  controller.observeSignal({
    type: 'speech_started',
    segmentId: 'segment-1',
    at: 100,
  });
  controller.observeSignal({
    type: 'speech_ended',
    segmentId: 'segment-1',
    at: 200,
  });
  controller.observeSignal({
    type: 'recognition_failed',
    code: 'network',
    at: 300,
  });

  const events = timeline.snapshot();
  assert.equal(events[0]?.kind, 'turn_signal');
  assert.equal(events[0]?.kind === 'turn_signal' ? events[0].signal : null, 'speech_started');
  assert.equal(controller.getState(300).floorOwner, 'none');
  assert.equal(JSON.stringify(events).includes('昨日'), false);
});
