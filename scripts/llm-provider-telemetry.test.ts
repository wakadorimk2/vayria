import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  createLlmProviderCallTracker,
  summarizeInteractiveLlmProviderLatency,
  type LlmExternalRequestEvent,
  type LlmProviderEvent,
  type LlmProviderSource,
} from '../server/llmProviderTelemetry.js';
import { OpenAiResponsesError } from '../server/openAiResponses.js';
import {
  bindLlmProviderAbort,
  resolveLlmProviderSource,
} from '../server/localApi.js';
import { DEFAULT_PROGRAM_CONTEXT } from '../src/conversation/programContext.js';

function createHarness(source: LlmProviderSource = 'manual') {
  const events: LlmProviderEvent[] = [];
  const externalEvents: LlmExternalRequestEvent[] = [];
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
    recordExternal: (event) => {
      externalEvents.push(event);
    },
  });
  return {
    events,
    externalEvents,
    tracker,
    setClock(value: number) {
      clock = value;
    },
  };
}

async function flushTelemetryQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('external requests keep turn-wide indexes and parent call metadata', async () => {
  const harness = createHarness('voice');
  const incomplete = new OpenAiResponsesError('sensitive provider message', {
    kind: 'incomplete',
    incompleteReason: 'max_output_tokens',
    usage: {
      inputTokens: 100,
      cachedTokens: 80,
      cacheWriteTokens: 0,
      outputTokens: 2_048,
      reasoningTokens: 2_000,
    },
  });

  await assert.rejects(
    harness.tracker.run(
      { purpose: 'response-generation', retry: 0 },
      async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
        trackExternalRequest(
          {
            apiEndpoint: 'responses',
            maxOutputTokens: 2_048,
            metadata: { requestedTier: 'standard', cacheMode: 'implicit' },
          },
          async (markFirstChunk) => {
            harness.setClock(4);
            markFirstChunk();
            harness.setClock(10);
            throw incomplete;
          },
        ),
    ),
    (error: unknown) => error === incomplete,
  );

  harness.setClock(20);
  await harness.tracker.run(
    { purpose: 'response-generation', retry: 1 },
    async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) => {
      await assert.rejects(
        trackExternalRequest(
          {
            apiEndpoint: 'responses',
            maxOutputTokens: 4_096,
            metadata: { requestedTier: 'standard', cacheMode: 'implicit' },
          },
          async () => {
            harness.setClock(30);
            throw incomplete;
          },
        ),
        (error: unknown) => error === incomplete,
      );
      return trackExternalRequest(
        {
          apiEndpoint: 'chat-completions',
          model: 'gpt-5-nano',
          metadata: { cacheMode: 'disabled', cacheStatus: 'disabled' },
        },
        async (markFirstChunk) => {
          harness.setClock(35);
          markFirstChunk();
          harness.setClock(40);
          return 'ok';
        },
      );
    },
  );
  await flushTelemetryQueue();

  const done = harness.externalEvents.filter(
    (event) => event.event === 'llm_external_request_done',
  );
  assert.deepEqual(
    done.map((event) => ({
      externalRequestIndex: event.externalRequestIndex,
      callIndex: event.callIndex,
      retry: event.retry,
      apiEndpoint: event.apiEndpoint,
      maxOutputTokens: event.maxOutputTokens,
      terminationKind: event.terminationKind,
    })),
    [
      {
        externalRequestIndex: 1,
        callIndex: 1,
        retry: 0,
        apiEndpoint: 'responses',
        maxOutputTokens: 2_048,
        terminationKind: 'incomplete',
      },
      {
        externalRequestIndex: 2,
        callIndex: 2,
        retry: 1,
        apiEndpoint: 'responses',
        maxOutputTokens: 4_096,
        terminationKind: 'incomplete',
      },
      {
        externalRequestIndex: 3,
        callIndex: 2,
        retry: 1,
        apiEndpoint: 'chat-completions',
        maxOutputTokens: undefined,
        terminationKind: 'success',
      },
    ],
  );
  assert.deepEqual(
    {
      incompleteReason: done[0]?.incompleteReason,
      inputTokens: done[0]?.inputTokens,
      outputTokens: done[0]?.outputTokens,
      reasoningTokens: done[0]?.reasoningTokens,
    },
    {
      incompleteReason: 'max_output_tokens',
      inputTokens: 100,
      outputTokens: 2_048,
      reasoningTokens: 2_000,
    },
  );
  assert.deepEqual(
    harness.externalEvents.map((event) => event.event),
    [
      'llm_external_request_start',
      'llm_external_request_first_chunk',
      'llm_external_request_done',
      'llm_external_request_start',
      'llm_external_request_done',
      'llm_external_request_start',
      'llm_external_request_first_chunk',
      'llm_external_request_done',
    ],
  );
});

test('external telemetry records safe legacy HTTP status without error content', async () => {
  const harness = createHarness('voice');
  const legacyError = Object.assign(new Error('secret response body'), {
    name: 'HttpError',
    status: 503,
    body: 'private body',
    statusText: 'private status text',
  });
  await assert.rejects(
    harness.tracker.run(
      { purpose: 'response-generation', retry: 1 },
      async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
        trackExternalRequest(
          { apiEndpoint: 'chat-completions' },
          async () => {
            throw legacyError;
          },
        ),
    ),
    (error: unknown) => error === legacyError,
  );
  await flushTelemetryQueue();
  const done = harness.externalEvents.at(-1);
  assert.equal(done?.terminationKind, 'http_error');
  assert.equal(done?.httpStatus, 503);
  assert.doesNotMatch(
    JSON.stringify(done),
    /apiKey|body|history|message|prompt|statusText|text|secret|private/i,
  );
});

test('external telemetry failures do not change the provider result', async () => {
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-external-record-failure',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'voice',
    record: () => undefined,
    recordExternal: async () => {
      throw new Error('telemetry storage failed');
    },
  });
  const result = await tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
      trackExternalRequest(
        { apiEndpoint: 'responses', maxOutputTokens: 2_048 },
        async (markFirstChunk) => {
          markFirstChunk();
          return 'provider result';
        },
      ),
  );
  assert.equal(result, 'provider result');
});

test('external storage latency does not extend the logical provider call', async () => {
  let releaseStorage: (() => void) | undefined;
  const storageBlocked = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-external-storage-latency',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'voice',
    record: () => undefined,
    recordExternal: () => storageBlocked,
  });
  let settled = false;
  const resultPromise = tracker
    .run(
      { purpose: 'response-generation', retry: 0 },
      async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
        trackExternalRequest(
          { apiEndpoint: 'responses', maxOutputTokens: 2_048 },
          async () => 'provider result',
        ),
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal(await resultPromise, 'provider result');
  releaseStorage?.();
});

test('external telemetry classifies abort without recording error details', async () => {
  const harness = createHarness('voice');
  const abortError = new OpenAiResponsesError('private abort detail', {
    kind: 'aborted',
  });
  await assert.rejects(
    harness.tracker.run(
      { purpose: 'response-generation', retry: 0 },
      async (_markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
        trackExternalRequest(
          { apiEndpoint: 'responses', maxOutputTokens: 2_048 },
          async () => {
            throw abortError;
          },
        ),
    ),
    (error: unknown) => error === abortError,
  );
  await flushTelemetryQueue();
  const done = harness.externalEvents.at(-1);
  assert.equal(done?.terminationKind, 'aborted');
  assert.doesNotMatch(JSON.stringify(done), /detail|message|private/i);
});

test('external events stay server-only and use the safe field allowlist', async () => {
  const observed: LlmProviderEvent[] = [];
  const externalEvents: LlmExternalRequestEvent[] = [];
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-server-only',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'voice',
    observe: (event) => observed.push(event),
    record: () => undefined,
    recordExternal: (event) => {
      externalEvents.push(event);
    },
  });
  await tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markProviderChunk, _setProviderMetadata, trackExternalRequest) =>
      trackExternalRequest(
        {
          apiEndpoint: 'responses',
          maxOutputTokens: 2_048,
          metadata: { requestedTier: 'standard', cacheMode: 'implicit' },
        },
        async (markExternalChunk, setExternalMetadata) => {
          markExternalChunk();
          markProviderChunk();
          setExternalMetadata({
            actualTier: 'default',
            cacheStatus: 'hit',
            inputTokens: 120,
            cachedTokens: 100,
            cacheWriteTokens: 0,
            outputTokens: 20,
            reasoningTokens: 10,
          });
        },
      ),
  );
  await flushTelemetryQueue();

  assert.deepEqual(
    observed.map((event) => event.event),
    ['llm_provider_start', 'llm_provider_first_chunk', 'llm_provider_done'],
  );
  const approvedExternalFields = [
    'actualTier',
    'apiEndpoint',
    'cacheMode',
    'cacheStatus',
    'cacheWriteTokens',
    'cachedTokens',
    'callIndex',
    'elapsedMs',
    'event',
    'externalRequestIndex',
    'inputTokens',
    'maxOutputTokens',
    'model',
    'outputTokens',
    'provider',
    'purpose',
    'reasoningTokens',
    'requestedTier',
    'retry',
    'source',
    'terminationKind',
    'turnId',
  ];
  assert.deepEqual(
    Object.keys(externalEvents.at(-1) ?? {}).sort(),
    approvedExternalFields,
  );
  assert.doesNotMatch(
    JSON.stringify(externalEvents),
    /apiKey|body|history|message|prompt|statusText|text/i,
  );
});

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

test('telemetry recording failures do not change the provider result or event order', async () => {
  const attempts: string[] = [];
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-record-failure',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'manual',
    record: async (event) => {
      attempts.push(event.event);
      if (event.event !== 'llm_provider_done') {
        throw new Error(`record failed: ${event.event}`);
      }
    },
  });

  const result = await tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk) => {
      markFirstChunk();
      return 'provider result';
    },
  );

  assert.equal(result, 'provider result');
  assert.deepEqual(attempts, [
    'llm_provider_start',
    'llm_provider_first_chunk',
    'llm_provider_done',
  ]);
});

test('provider completion accepts safe cache metadata only on done', async () => {
  const harness = createHarness();
  await harness.tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk, setMetadata) => {
      markFirstChunk();
      setMetadata({
        profile: 'luna-explicit',
        cacheStatus: 'hit',
        inputTokens: 200,
        cachedTokens: 160,
        requestBytes: 1200,
      });
    },
  );
  assert.equal(harness.events[0]?.profile, undefined);
  assert.equal(harness.events[1]?.profile, undefined);
  assert.deepEqual(
    {
      profile: harness.events[2]?.profile,
      cacheStatus: harness.events[2]?.cacheStatus,
      inputTokens: harness.events[2]?.inputTokens,
      cachedTokens: harness.events[2]?.cachedTokens,
      requestBytes: harness.events[2]?.requestBytes,
    },
    {
      profile: 'luna-explicit',
      cacheStatus: 'hit',
      inputTokens: 200,
      cachedTokens: 160,
      requestBytes: 1200,
    },
  );
  assert.doesNotMatch(
    JSON.stringify(harness.events[2]),
    /apiKey|history|message|prompt|text/i,
  );
});

test('provider observer receives ordered milestones without waiting for storage', async () => {
  const observed: string[] = [];
  let releaseStorage: (() => void) | undefined;
  const storageBlocked = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-observer',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'voice',
    observe: (event) => observed.push(event.event),
    record: () => storageBlocked,
  });

  const resultPromise = tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk) => {
      markFirstChunk();
      return 'ok';
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [
    'llm_provider_start',
    'llm_provider_first_chunk',
    'llm_provider_done',
  ]);
  releaseStorage?.();
  assert.equal(await resultPromise, 'ok');
});

test('provider observer failure does not change the provider result', async () => {
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-observer-failure',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'manual',
    observe: () => {
      throw new Error('observer failed');
    },
    record: () => undefined,
  });

  const result = await tracker.run(
    { purpose: 'response-generation', retry: 0 },
    async (markFirstChunk) => {
      markFirstChunk();
      return 'ok';
    },
  );
  assert.equal(result, 'ok');
});

test('telemetry completion failure does not mask a provider failure', async () => {
  const tracker = createLlmProviderCallTracker({
    turnId: 'turn-provider-failure',
    provider: 'openai',
    model: 'gpt-5-nano',
    source: 'voice',
    record: async (event) => {
      if (event.event === 'llm_provider_done') {
        throw new Error('done recording failed');
      }
    },
  });

  await assert.rejects(
    tracker.run(
      { purpose: 'response-generation', retry: 0 },
      async () => {
        throw new Error('provider failed');
      },
    ),
    /provider failed/,
  );
});

test('provider abort binding observes response close and removes both listeners', () => {
  const request = new EventEmitter() as unknown as IncomingMessage;
  const response = new EventEmitter() as unknown as ServerResponse;
  Object.defineProperty(response, 'writableEnded', {
    configurable: true,
    value: false,
  });
  const controller = new AbortController();
  const unbind = bindLlmProviderAbort(request, response, controller);

  assert.equal(request.listenerCount('aborted'), 1);
  assert.equal(response.listenerCount('close'), 1);
  response.emit('close');
  assert.equal(controller.signal.aborted, true);

  unbind();
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
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
    { ...done('voice', 1), warmup: 1 },
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
