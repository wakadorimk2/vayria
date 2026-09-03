import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAiResponsesError,
  buildOpenAiResponsesBody,
  streamOpenAiResponse,
  type OpenAiResponseRequest,
} from '../server/openAiResponses.js';

const baseRequest: OpenAiResponseRequest = {
  apiKey: 'test-key',
  model: 'gpt-5.6-luna',
  staticPrompt: 'fixed rules',
  dynamicPrompt: 'dynamic context',
  history: [{ role: 'assistant', content: 'history' }],
  userMessage: 'hello',
  output: {
    name: 'test_response',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  maxOutputTokens: 128,
  serviceTier: 'fast',
  cache: {
    key: 'vayria:test:v1',
    explicitBreakpoint: true,
  },
};

function streamResponse(bytes: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byteChunk of bytes) controller.enqueue(byteChunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test('Responses body uses Luna structured output without storage', () => {
  const body = buildOpenAiResponsesBody(baseRequest);
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.service_tier, 'fast');
  assert.equal(body.prompt_cache_key, 'vayria:test:v1');
  assert.deepEqual(body.prompt_cache_options, {
    mode: 'explicit',
    ttl: '30m',
  });
  const input = body.input as Array<Record<string, unknown>>;
  const firstContent = input[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(firstContent[0]?.prompt_cache_breakpoint, {
    mode: 'explicit',
  });
  assert.equal(JSON.stringify(body).includes('test-key'), false);
});

test('standard tier and cache-disabled requests omit optional cache fields', () => {
  const body = buildOpenAiResponsesBody({
    ...baseRequest,
    serviceTier: 'standard',
    cache: undefined,
  });
  assert.equal('service_tier' in body, false);
  assert.equal('prompt_cache_key' in body, false);
  assert.equal('prompt_cache_options' in body, false);
  const input = body.input as Array<Record<string, unknown>>;
  const firstContent = input[0]?.content as Array<Record<string, unknown>>;
  assert.equal('prompt_cache_breakpoint' in firstContent[0]!, false);
});

test('Responses SSE parser preserves Unicode across every byte boundary', async () => {
  const wire = [
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"えっ🌙"}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"service_tier":"priority","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80,"cache_write_tokens":20},"output_tokens":12,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const encoded = new TextEncoder().encode(wire);
  const chunks = Array.from(encoded, (value) => Uint8Array.of(value));
  const deltas: string[] = [];
  const result = await streamOpenAiResponse({
    ...baseRequest,
    onTextDelta: (delta) => deltas.push(delta),
    fetchImpl: async () => streamResponse(chunks),
  });
  assert.equal(result.text, 'えっ🌙');
  assert.deepEqual(deltas, ['えっ🌙']);
  assert.equal(result.serviceTier, 'priority');
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    cachedTokens: 80,
    cacheWriteTokens: 20,
    outputTokens: 12,
    reasoningTokens: 0,
  });
});

test('incomplete output is not classified as availability fallback', async () => {
  const wire =
    'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n';
  await assert.rejects(
    streamOpenAiResponse({
      ...baseRequest,
      fetchImpl: async () =>
        streamResponse([new TextEncoder().encode(wire)]),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiResponsesError);
      assert.equal(error.kind, 'incomplete');
      assert.equal(error.retryableAvailabilityFailure, false);
      return true;
    },
  );
});

test('HTTP 429 is classified as an availability fallback', async () => {
  await assert.rejects(
    streamOpenAiResponse({
      ...baseRequest,
      fetchImpl: async () => new Response('', { status: 429 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiResponsesError);
      assert.equal(error.status, 429);
      assert.equal(error.retryableAvailabilityFailure, true);
      return true;
    },
  );
});

test('request abort is forwarded and is not an availability fallback', async () => {
  const controller = new AbortController();
  const pending = streamOpenAiResponse({
    ...baseRequest,
    signal: controller.signal,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof OpenAiResponsesError);
    assert.equal(error.kind, 'aborted');
    assert.equal(error.retryableAvailabilityFailure, false);
    return true;
  });
});
