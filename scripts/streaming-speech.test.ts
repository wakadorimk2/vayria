import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IncrementalSpeechEnvelopeParser,
  parseStreamingSpeechEnvelope,
} from '../server/streamingSpeech.js';
import { readStreamingChatEvents } from '../src/conversation/streamingSpeech.js';

const envelope = JSON.stringify({
  deliveryHeader: {
    voiceAction: 'take_floor',
    backchannelCue: 'none',
    emotion: 'surprised',
    activatedCards: ['card-a'],
  },
  speechUnits: ['えっ、「赤」？\n', '\u30ab\u30fc\u30c9ですわ。'],
  internalDelta: { reasonUpdates: [] },
});

function parseChunks(chunks: readonly string[]) {
  const parser = new IncrementalSpeechEnvelopeParser();
  let header: unknown;
  const speechUnits: string[] = [];
  for (const chunk of chunks) {
    const parsed = parser.push(chunk);
    if (parsed.deliveryHeader !== undefined) header = parsed.deliveryHeader;
    speechUnits.push(...parsed.speechUnits);
  }
  return { header, speechUnits };
}

test('incremental speech parser handles every two-chunk boundary', () => {
  for (let offset = 0; offset <= envelope.length; offset += 1) {
    const result = parseChunks([envelope.slice(0, offset), envelope.slice(offset)]);
    assert.deepEqual(result.header, {
      voiceAction: 'take_floor',
      backchannelCue: 'none',
      emotion: 'surprised',
      activatedCards: ['card-a'],
    });
    assert.deepEqual(result.speechUnits, ['えっ、「赤」？\n', 'カードですわ。']);
  }
});

test('incremental speech parser handles one-character chunks without duplicates', () => {
  const result = parseChunks([...envelope]);
  assert.deepEqual(result.speechUnits, ['えっ、「赤」？\n', 'カードですわ。']);
});

test('complete streaming envelope keeps delivery and state separate', () => {
  const parsed = parseStreamingSpeechEnvelope(envelope);
  assert.equal(parsed.deliveryHeader.voiceAction, 'take_floor');
  assert.deepEqual(parsed.speechUnits, ['えっ、「赤」？\n', 'カードですわ。']);
  assert.deepEqual(parsed.internalDelta, { reasonUpdates: [] });
});

test('NDJSON reader handles byte boundaries and preserves event order', async () => {
  const records = [
    {
      type: 'provider_timing',
      milestone: 'start',
      purpose: 'response-generation',
      callIndex: 1,
      retry: 0,
    },
    {
      type: 'provider_timing',
      milestone: 'first_chunk',
      purpose: 'response-generation',
      callIndex: 1,
      retry: 0,
    },
    {
      type: 'speech_unit',
      index: 0,
      text: 'えっ、',
      response: { text: 'えっ、', emotion: 'surprised' },
    },
    { type: 'state', internalDelta: { reasonUpdates: [] }, rejected: false },
    { type: 'done', response: { text: 'えっ、', emotion: 'surprised' } },
  ];
  const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const received: string[] = [];
  await readStreamingChatEvents(new Response(stream), (event) => {
    received.push(event.type);
  });
  assert.deepEqual(received, [
    'provider_timing',
    'provider_timing',
    'speech_unit',
    'state',
    'done',
  ]);
});
