import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLlmProviderCallTracker,
  summarizeInteractiveLlmProviderLatency,
  type LlmProviderEvent,
  type LlmProviderSource,
} from '../server/llmProviderTelemetry.js';
import { resolveLlmProviderSource } from '../server/localApi.js';
import { DEFAULT_PROGRAM_CONTEXT } from '../src/conversation/programContext.js';

function createHarness(source: LlmProviderSource = 'manual') {
  const events: LlmProviderEvent[] = [];
  let clock = 0;
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-telemetry-1',
    provider: 'openai',
    model: 'gpt-5-nano',
    source,
    now: () => clock,
    record: (event) => {
      events.push(event);
    },
  });
  return {
    events,
    tracker,
    setClock(value: number) {
      clock = value;
    },
  };
}

test('one streaming provider call records start, first chunk, and completion', async () => {
  const harness = createHarness();
  const result = await harness.tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk) => {
      harness.setClock(12);
      markFirstChunk();
      harness.setClock(25);
      return 'ok';
    },
  );

  assert.equal(result, 'ok');
  assert.equal(harness.tracker.callCount, 1);
  assert.deepEqual(
    harness.events.map((event) => [
      event.event,
      event.turnId,
      event.callIndex,
      event.retry,
      event.elapsedMs,
    ]),
    [
      ['llm_provider_start', 'turn-telemetry-1', 1, 0, 0],
      ['llm_provider_first_chunk', 'turn-telemetry-1', 1, 0, 12],
      ['llm_provider_done', 'turn-telemetry-1', 1, 0, 25],
    ],
  );
});

test('two provider calls keep call indexes and retry metadata on failure', async () => {
  const harness = createHarness('voice');
  await harness.tracker.run(
    { purpose: 'conversation-policy', retry: 0 },
    async (markFirstChunk) => {
      harness.setClock(5);
      markFirstChunk();
      harness.setClock(8);
    },
  );

  harness.setClock(20);
  await assert.rejects(
    harness.tracker.run(
      { purpose: 'conversation-policy', retry: 1 },
      async () => {
        harness.setClock(31);
        throw new Error('provider failed');
      },
    ),
    /provider failed/,
  );

  assert.equal(harness.tracker.callCount, 2);
  assert.deepEqual(
    harness.events
      .filter((event) => event.event === 'llm_provider_done')
      .map((event) => ({ callIndex: event.callIndex, retry: event.retry })),
    [
      { callIndex: 1, retry: 0 },
      { callIndex: 2, retry: 1 },
    ],
  );
});

test('a non-streaming response marks receipt as its first chunk', async () => {
  const harness = createHarness('card-preview');
  await harness.tracker.run(
    { purpose: 'card-preview', retry: 0 },
    async (markFirstChunk) => {
      harness.setClock(40);
      markFirstChunk();
      harness.setClock(41);
    },
  );

  assert.equal(harness.events[1]?.event, 'llm_provider_first_chunk');
  assert.equal(harness.events[1]?.elapsedMs, 40);
});

test('an aborted call records completion and ignores late chunks', async () => {
  const events: LlmProviderEvent[] = [];
  const controller = new AbortController();
  let markLateChunk: (() => void) | undefined;
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-abort',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'manual',
    signal: controller.signal,
    record: (event) => {
      events.push(event);
    },
  });
  const providerCall = tracker.run(
    { purpose: 'response-generation', retry: 0 },
    (markFirstChunk) => {
      markLateChunk = markFirstChunk;
      return new Promise<string>(() => undefined);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(providerCall, { name: 'AbortError' });
  markLateChunk?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.map((event) => event.event),
    ['llm_provider_start', 'llm_provider_done'],
  );
});

test('provider telemetry contains only the approved safe fields', async () => {
  const harness = createHarness();
  await harness.tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk) => markFirstChunk(),
  );
  const approvedFields = [
    'callIndex',
    'elapsedMs',
    'event',
    'model',
    'provider',
    'purpose',
    'retry',
    'source',
    'turnId',
  ];
  for (const event of harness.events) {
    assert.deepEqual(Object.keys(event).sort(), approvedFields);
    assert.doesNotMatch(JSON.stringify(event), /apiKey|history|message|prompt|text/i);
  }
});

test('interactive summaries calculate p50 and p95 and exclude autonomous calls', () => {
  const done = (
    source: LlmProviderSource,
    elapsedMs: number,
  ): LlmProviderEvent => ({
    event: 'llm_provider_done',
    turnId: `turn-${source}-${elapsedMs}`,
    provider: 'openai',
    model: 'gpt-5-nano',
    purpose: 'response-generation',
    source,
    callIndex: 1,
    retry: 0,
    elapsedMs,
  });
  const summary = summarizeInteractiveLlmProviderLatency([
    done('manual', 10),
    done('manual', 20),
    done('manual', 100),
    done('voice', 30),
    done('card_change', 40),
    done('autonomous', 9_999),
  ]);

  assert.deepEqual(summary, [
    { source: 'voice', sampleCount: 1, p50Ms: 30, p95Ms: 30 },
    { source: 'manual', sampleCount: 3, p50Ms: 20, p95Ms: 100 },
    { source: 'card_change', sampleCount: 1, p50Ms: 40, p95Ms: 40 },
  ]);
});

test('card-change autonomous requests use the separate SLO source', () => {
  assert.equal(
    resolveLlmProviderSource('autonomous', 'chicken', {
      ...DEFAULT_PROGRAM_CONTEXT,
      phase: 'after_card_change',
    }),
    'card_change',
  );
  assert.equal(
    resolveLlmProviderSource(
      'autonomous',
      null,
      DEFAULT_PROGRAM_CONTEXT,
    ),
    'autonomous',
  );
  assert.equal(
    resolveLlmProviderSource('manual', 'chicken', {
      ...DEFAULT_PROGRAM_CONTEXT,
      phase: 'after_card_change',
    }),
    'manual',
  );
});
