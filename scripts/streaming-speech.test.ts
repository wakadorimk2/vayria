import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IncrementalSpeechEnvelopeParser,
  isAcceptedSpeechLead,
  isValidSpeechLead,
  parseStreamingSpeechEnvelope,
} from '../server/streamingSpeech.js';
import { readStreamingChatEvents } from '../src/conversation/streamingSpeech.js';

const envelope = JSON.stringify({
  deliveryHeader: {
    voiceAction: 'take_floor',
    backchannelCue: 'none',
    emotion: 'surprised',
  },
  speechLead: 'えっ、「赤」？\n',
  speechUnits: ['\u30ab\u30fc\u30c9ですわ。'],
  activatedCards: ['card-a'],
  internalDelta: { reasonUpdates: [] },
});

function parseChunks(chunks: readonly string[]) {
  const parser = new IncrementalSpeechEnvelopeParser();
  let header: unknown;
  let speechLead: string | undefined;
  const speechUnits: string[] = [];
  for (const chunk of chunks) {
    const parsed = parser.push(chunk);
    if (parsed.deliveryHeader !== undefined) header = parsed.deliveryHeader;
    if (parsed.speechLead !== undefined) speechLead = parsed.speechLead;
    speechUnits.push(...parsed.speechUnits);
  }
  return { header, speechLead, speechUnits };
}

test('incremental speech parser handles every two-chunk boundary', () => {
  for (let offset = 0; offset <= envelope.length; offset += 1) {
    const result = parseChunks([envelope.slice(0, offset), envelope.slice(offset)]);
    assert.deepEqual(result.header, {
      voiceAction: 'take_floor',
      backchannelCue: 'none',
      emotion: 'surprised',
    });
    assert.equal(result.speechLead, 'えっ、「赤」？\n');
    assert.deepEqual(result.speechUnits, ['カードですわ。']);
  }
});

test('incremental speech parser handles one-character chunks without duplicates', () => {
  const result = parseChunks([...envelope]);
  assert.equal(result.speechLead, 'えっ、「赤」？\n');
  assert.deepEqual(result.speechUnits, ['カードですわ。']);
});

test('complete streaming envelope keeps delivery and state separate', () => {
  const parsed = parseStreamingSpeechEnvelope(envelope);
  assert.equal(parsed.deliveryHeader.voiceAction, 'take_floor');
  assert.equal(parsed.speechLead, 'えっ、「赤」？\n');
  assert.deepEqual(parsed.speechUnits, ['カードですわ。']);
  assert.deepEqual(parsed.activatedCards, ['card-a']);
  assert.deepEqual(parsed.internalDelta, { reasonUpdates: [] });
});

test('speech lead validation accepts only natural 4 to 12 character units', () => {
  assert.equal(isAcceptedSpeechLead(''), true);
  assert.equal(isValidSpeechLead(''), false);
  assert.equal(isValidSpeechLead('えっ待って'), true);
  assert.equal(isValidSpeechLead('１２３４５６７８９０１２'), true);
  assert.equal(isValidSpeechLead('１２３４５６７８９０１２３'), false);
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
    {
      type: 'provider_timing',
      milestone: 'done',
      purpose: 'response-generation',
      callIndex: 1,
      retry: 0,
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
    'provider_timing',
    'state',
    'done',
  ]);
});

test('the first committed speech unit arrives before provider completion', async () => {
  const records = [
    {
      type: 'speech_unit',
      index: 0,
      text: 'えっ待って',
      response: { text: 'えっ待って', emotion: 'surprised' },
    },
    {
      type: 'provider_timing',
      milestone: 'done',
      purpose: 'response-generation',
      callIndex: 1,
      retry: 0,
    },
    { type: 'done', response: { text: 'えっ待って', emotion: 'surprised' } },
  ];
  const response = new Response(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  const order: string[] = [];
  await readStreamingChatEvents(response, (event) => {
    if (event.type === 'speech_unit') order.push('tts_request');
    if (event.type === 'provider_timing' && event.milestone === 'done') {
      order.push('provider_done');
    }
  });
  assert.deepEqual(order, ['tts_request', 'provider_done']);
});
