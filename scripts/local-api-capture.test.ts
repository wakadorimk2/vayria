import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  localApiPlugin,
  parseVoiceAssistantResponse,
} from '../server/localApi.js';
import {
  type ExhibitionCaptureMetadata,
  readExhibitionCaptureMetadata,
  readExhibitionEvents,
} from '../server/exhibitionCaptureStore.js';
import {
  readPlaycheckRecords,
} from '../server/playcheckStore.js';

interface FakeServer {
  middlewares: {
    use(handler: Middleware): void;
  };
  httpServer: EventEmitter;
}

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

function createFakeServer(): {
  server: FakeServer;
  handlers: Middleware[];
} {
  const handlers: Middleware[] = [];
  const server: FakeServer = {
    middlewares: {
      use(handler) {
        handlers.push(handler);
      },
    },
    httpServer: new EventEmitter(),
  };
  return { server, handlers };
}

test('voice assistant response keeps action, text, and card contracts together', () => {
  const brainCardIds = ['card-a'];
  const listen = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'listen',
      backchannelCue: 'none',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
    }),
    brainCardIds,
    'card-a',
    'えっと',
  );
  assert.equal(listen.voiceAction, 'listen');
  assert.equal(listen.text, '');
  assert.deepEqual(listen.activatedCards, []);

  const backchannel = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'backchannel',
      backchannelCue: 'un',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
    }),
    brainCardIds,
    'card-a',
    'うん',
  );
  assert.equal(backchannel.voiceAction, 'backchannel');
  assert.equal(backchannel.backchannelCue, 'un');

  const takeFloor = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'take_floor',
      backchannelCue: 'none',
      text: 'それは面白いですわ',
      emotion: 'joy',
      activatedCards: ['card-a'],
    }),
    brainCardIds,
    'card-a',
    '展示について聞きたいです',
  );
  assert.equal(takeFloor.voiceAction, 'take_floor');
  assert.equal(takeFloor.text, 'それは面白いですわ');
  assert.deepEqual(takeFloor.activatedCards, ['card-a']);

  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'listen',
          backchannelCue: 'none',
          text: '',
          emotion: 'neutral',
          activatedCards: [],
        }),
        brainCardIds,
        null,
        '展示について聞きたいです',
      ),
    /take_floor/,
  );
});

async function waitForCaptureId(root: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const entries = await readdir(join(root, 'exhibition'), {
        withFileTypes: true,
      });
      const capture = entries.find((entry) => entry.isDirectory());
      if (capture) return capture.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('Exhibition capture was not initialized.');
}

async function waitForCaptureCompletion(
  root: string,
  captureId: string,
): Promise<ExhibitionCaptureMetadata> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const metadata = await readExhibitionCaptureMetadata(root, captureId);
      if (metadata.status === 'completed') return metadata;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('Exhibition capture was not finalized.');
}

async function postEvent(
  handler: Middleware,
  body: object,
  headers: Record<string, string> = {},
): Promise<number> {
  const request = Object.assign(
    Readable.from([JSON.stringify(body)]),
    {
      method: 'POST',
      url: '/api/events',
      headers,
    },
  ) as unknown as IncomingMessage;
  let statusCode = 0;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const response = {
    writeHead(status: number) {
      statusCode = status;
    },
    end() {
      resolveEnded();
    },
  } as unknown as ServerResponse;
  handler(request, response, () => undefined);
  await Promise.race([
    ended,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    }),
  ]);
  return statusCode;
}

async function requestRoute(
  handler: Middleware,
  options: {
    abortAfterMs?: number;
    backpressureOnFirstWrite?: boolean;
    method: string;
    url: string;
    body?: object;
  },
): Promise<{
  statusCode: number;
  body: string;
  chunks: Buffer[];
  destroyed: boolean;
  headers: Record<string, string | number | readonly string[]>;
}> {
  const requestBody = options.body === undefined ? [] : [JSON.stringify(options.body)];
  const request = Object.assign(
    Readable.from(requestBody),
    {
      method: options.method,
      url: options.url,
      headers: {},
    },
  ) as unknown as IncomingMessage;
  let requestAborted = false;
  Object.defineProperty(request, 'aborted', {
    configurable: true,
    get: () => requestAborted,
  });
  let statusCode = 0;
  let body = '';
  const chunks: Buffer[] = [];
  let headers: Record<string, string | number | readonly string[]> = {};
  let writeCount = 0;
  let responseHeadersSent = false;
  let responseWritableEnded = false;
  let responseDestroyed = false;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const responseEmitter = new EventEmitter();
  Object.defineProperties(responseEmitter, {
    headersSent: { get: () => responseHeadersSent },
    writableEnded: { get: () => responseWritableEnded },
  });
  const response = Object.assign(responseEmitter, {
    writeHead(status: number, nextHeaders: Record<string, string | number | readonly string[]> = {}) {
      statusCode = status;
      headers = nextHeaders;
      responseHeadersSent = true;
      return response;
    },
    write(chunk: string | Buffer) {
      writeCount += 1;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(value);
      body += value.toString();
      if (options.backpressureOnFirstWrite && writeCount === 1) {
        setImmediate(() => response.emit('drain'));
        return false;
      }
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(value);
        body += value.toString();
      }
      responseWritableEnded = true;
      resolveEnded();
    },
    destroy() {
      responseDestroyed = true;
      responseWritableEnded = true;
      resolveEnded();
      return response;
    },
  }) as unknown as ServerResponse;
  handler(request, response, () => undefined);
  if (options.abortAfterMs !== undefined) {
    setTimeout(() => {
      requestAborted = true;
      request.emit('aborted');
    }, options.abortAfterMs);
  }
  await Promise.race([
    ended,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    }),
  ]);
  return {
    statusCode,
    body,
    chunks,
    destroyed: responseDestroyed,
    headers,
  };
}

function configurePlugin(
  config: Parameters<typeof localApiPlugin>[0],
  fake: FakeServer,
): void {
  const plugin = localApiPlugin(config);
  if (!plugin.configureServer || typeof plugin.configureServer !== 'function') {
    throw new Error('local API plugin has no configureServer hook.');
  }
  const configureServer = plugin.configureServer as unknown as (
    server: FakeServer,
  ) => void;
  configureServer(fake);
}

test('health endpoint reports local availability when the Internet probe fails', async () => {
  const fake = createFakeServer();
  configurePlugin(
    {
      mode: 'exhibition',
      port: 5187,
      httpsEnabled: true,
      internetConnectivity: {
        async check() {
          return 'unavailable';
        },
        reset() {},
      },
      exhibitionNetwork: {
        start() {},
        stop() {},
        getAccess() {
          return {
            hostname: 'vayria.local',
            port: 5187,
            scheme: 'https',
            primaryUrl: 'https://vayria.local:5187',
            fallbackUrl: 'https://192.168.137.2:5187',
            fallbackTlsValid: true,
            recommendedUrl: 'https://vayria.local:5187',
            mdns: 'available',
            hotspotIp: '192.168.137.2',
          };
        },
        getHotspotAddress() {
          return { interfaceName: 'Local Area Connection* 12', address: '192.168.137.2' };
        },
        getMdnsStatus() {
          return 'available';
        },
      },
    },
    fake.server,
  );
  assert.equal(fake.handlers.length, 1);

  const health = await requestRoute(fake.handlers[0], {
    method: 'GET',
    url: '/api/health',
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    service: 'vayria',
    mode: 'exhibition',
    network: {
      localNetwork: 'available',
      internet: 'unavailable',
    },
    access: {
      hostname: 'vayria.local',
      port: 5187,
      scheme: 'https',
      primaryUrl: 'https://vayria.local:5187',
      fallbackUrl: 'https://192.168.137.2:5187',
      fallbackTlsValid: true,
      recommendedUrl: 'https://vayria.local:5187',
      mdns: 'available',
      hotspotIp: '192.168.137.2',
    },
  });

  const invalidMethod = await requestRoute(fake.handlers[0], {
    method: 'POST',
    url: '/api/health',
    body: {},
  });
  assert.equal(invalidMethod.statusCode, 405);
});

test('Cloud TTS middleware forwards MP3 chunks and honors response backpressure', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer route-cloud-key');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    );
  };

  try {
    const fake = createFakeServer();
    configurePlugin({
      ttsBackend: 'aivis-cloud',
      aivisCloudApiKey: 'route-cloud-key',
      aivisCloudBaseUrl: 'https://cloud.example.test',
      aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
    }, fake.server);

    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'route fixture', emotion: 'joy' },
      backpressureOnFirstWrite: true,
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['Content-Type'], 'audio/mpeg');
    assert.equal(result.headers['X-Vayria-Tts-Backend'], 'aivis-cloud');
    assert.deepEqual(result.chunks.map((chunk) => [...chunk]), [[1, 2], [3, 4]]);
    assert.equal(requestBody?.text, 'route fixture');
    assert.equal(requestBody?.style_name, 'C');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit Local TTS mode keeps the WAV provider contract', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    createLocalTtsResponse(input) ?? new Response(null, { status: 500 });
  try {
    const fake = createFakeServer();
    configurePlugin({ ttsBackend: 'local' }, fake.server);
    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'local fixture', emotion: 'neutral' },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['Content-Type'], 'audio/wav');
    assert.equal(result.headers['X-Vayria-Tts-Backend'], 'local');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit Cloud TTS mode does not call Local after a Cloud failure', async () => {
  const originalFetch = globalThis.fetch;
  let localCalls = 0;
  globalThis.fetch = async (input) => {
    if (createLocalTtsResponse(input)) localCalls += 1;
    return new Response('private cloud response', { status: 401 });
  };
  try {
    const fake = createFakeServer();
    configurePlugin({
      ttsBackend: 'aivis-cloud',
      aivisCloudApiKey: 'route-cloud-key',
      aivisCloudBaseUrl: 'https://cloud.example.test',
      aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
    }, fake.server);
    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'cloud fixture', emotion: 'neutral' },
    });

    assert.equal(result.statusCode, 502);
    assert.equal(localCalls, 0);
    assert.equal(result.body.includes('private cloud response'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const LOCAL_WAV_FIXTURE = new Uint8Array([82, 73, 70, 70]);

function createLocalTtsResponse(
  input: Parameters<typeof fetch>[0],
): Response | undefined {
  const pathname = new URL(String(input)).pathname;
  if (pathname === '/speakers') {
    return Response.json([
      {
        name: 'zonoko',
        styles: [
          { id: 1, name: 'ノーマル' },
          { id: 2, name: 'ノーマル（Happy）' },
          { id: 3, name: 'ノーマル（Sad）' },
          { id: 4, name: 'ノーマル（Angry）' },
        ],
      },
    ]);
  }
  if (pathname === '/audio_query') return Response.json({});
  if (pathname === '/synthesis') return new Response(LOCAL_WAV_FIXTURE);
  return undefined;
}

test('Cloud-with-fallback selects Local once for safe pre-audio failures', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleInfo = console.info;
  const fallbackEvents: string[] = [];
  const cases = [
    { name: 'configuration', expected: 'configuration' },
    { name: '401', expected: 'authentication' },
    { name: '402', expected: 'quota' },
    { name: '404', expected: 'model' },
    { name: '422', expected: 'invalid_request' },
    { name: '429', expected: 'rate_limit' },
    { name: 'connection', expected: 'provider' },
    { name: 'empty', expected: 'provider' },
    { name: 'first-audio-timeout', expected: 'first_audio_timeout' },
    { name: 'total-timeout', expected: 'timeout' },
  ] as const;

  try {
    console.info = (...values: unknown[]) => {
      if (values[0] !== '[performer-event]' || typeof values[1] !== 'string') {
        return;
      }
      const event = JSON.parse(values[1]) as { event?: unknown };
      if (typeof event.event === 'string') fallbackEvents.push(event.event);
    };
    for (const fixture of cases) {
      let localSynthesisCalls = 0;
      globalThis.fetch = async (input, init) => {
        const local = createLocalTtsResponse(input);
        if (local) {
          if (new URL(String(input)).pathname === '/synthesis') {
            localSynthesisCalls += 1;
          }
          return local;
        }
        if (fixture.name === 'connection') throw new Error('private network detail');
        if (fixture.name === 'empty') {
          return new Response(
            new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
            { status: 200 },
          );
        }
        if (
          fixture.name === 'first-audio-timeout' ||
          fixture.name === 'total-timeout'
        ) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(new DOMException('aborted', 'AbortError')),
                  { once: true },
                );
              },
            }),
            { status: 200 },
          );
        }
        return new Response('private cloud response', { status: Number(fixture.name) });
      };

      const fake = createFakeServer();
      configurePlugin({
        ttsBackend: 'cloud-with-fallback',
        aivisCloudApiKey: fixture.name === 'configuration' ? '' : 'route-cloud-key',
        aivisCloudBaseUrl: 'https://cloud.example.test',
        aivisCloudFirstAudioTimeoutMs:
          fixture.name === 'total-timeout' ? 50 : 5,
        aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
        aivisCloudTimeoutMs: fixture.name === 'total-timeout' ? 5 : 100,
      }, fake.server);
      const result = await requestRoute(fake.handlers[0], {
        method: 'POST',
        url: '/api/tts',
        body: { text: 'private fixture text', emotion: 'neutral' },
      });

      assert.equal(result.statusCode, 200, fixture.name);
      assert.equal(result.headers['Content-Type'], 'audio/wav', fixture.name);
      assert.equal(result.headers['X-Vayria-Tts-Backend'], 'local', fixture.name);
      assert.equal(result.headers['X-Vayria-Tts-Fallback-From'], 'aivis-cloud', fixture.name);
      assert.equal(result.headers['X-Vayria-Tts-Fallback-Reason'], fixture.expected, fixture.name);
      assert.equal(localSynthesisCalls, 1, fixture.name);
      assert.deepEqual(result.chunks.at(-1), Buffer.from(LOCAL_WAV_FIXTURE), fixture.name);
      assert.equal(JSON.stringify(result.headers).includes('route-cloud-key'), false);
      assert.equal(JSON.stringify(result.headers).includes('private fixture text'), false);
      assert.equal(JSON.stringify(result.headers).includes('private cloud response'), false);
    }
  } finally {
    console.info = originalConsoleInfo;
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    fallbackEvents,
    cases.flatMap(() => [
      'tts_start',
      'tts_fallback_started',
      'tts_first_audio',
      'tts_completed',
      'tts_fallback_completed',
    ]),
  );
});

test('Cloud-with-fallback returns a safe 502 when Local fallback also fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname === '/speakers') {
      return new Response('private local response', { status: 500 });
    }
    return new Response('private cloud response', { status: 401 });
  };
  try {
    const fake = createFakeServer();
    configurePlugin({
      ttsBackend: 'cloud-with-fallback',
      aivisCloudApiKey: 'route-cloud-key',
      aivisCloudBaseUrl: 'https://cloud.example.test',
      aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
    }, fake.server);
    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'private fixture text', emotion: 'neutral' },
    });

    assert.equal(result.statusCode, 502);
    assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(result.body.includes('route-cloud-key'), false);
    assert.equal(result.body.includes('private fixture text'), false);
    assert.equal(result.body.includes('private cloud response'), false);
    assert.equal(result.body.includes('private local response'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloud-with-fallback does not replay Local after the first Cloud chunk', async () => {
  const originalFetch = globalThis.fetch;
  let localCalls = 0;
  globalThis.fetch = async (input) => {
    if (createLocalTtsResponse(input)) {
      localCalls += 1;
      return createLocalTtsResponse(input)!;
    }
    let emitted = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new Uint8Array([1, 2]));
            return;
          }
          controller.error(new Error('private stream detail'));
        },
      }),
      { status: 200 },
    );
  };
  try {
    const fake = createFakeServer();
    configurePlugin({
      ttsBackend: 'cloud-with-fallback',
      aivisCloudApiKey: 'route-cloud-key',
      aivisCloudBaseUrl: 'https://cloud.example.test',
      aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
    }, fake.server);
    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'private fixture text', emotion: 'neutral' },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['X-Vayria-Tts-Backend'], 'aivis-cloud');
    assert.deepEqual(result.chunks, [Buffer.from([1, 2])]);
    assert.equal(result.destroyed, true);
    assert.equal(localCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloud-with-fallback stops without Local synthesis after a client abort', async () => {
  const originalFetch = globalThis.fetch;
  let localCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (createLocalTtsResponse(input)) {
      localCalls += 1;
      return createLocalTtsResponse(input)!;
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
      { status: 200 },
    );
  };
  try {
    const fake = createFakeServer();
    configurePlugin({
      ttsBackend: 'cloud-with-fallback',
      aivisCloudApiKey: 'route-cloud-key',
      aivisCloudBaseUrl: 'https://cloud.example.test',
      aivisCloudFirstAudioTimeoutMs: 50,
      aivisCloudModelUuid: '11111111-2222-4333-8444-555555555555',
    }, fake.server);
    const result = await requestRoute(fake.handlers[0], {
      method: 'POST',
      url: '/api/tts',
      body: { text: 'private fixture text', emotion: 'neutral' },
      abortAfterMs: 5,
    });

    assert.equal(result.statusCode, 0);
    assert.equal(result.destroyed, true);
    assert.equal(localCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exhibition local API captures safe events and keeps Playcheck raw priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-local-api-capture-'));
  try {
    const fake = createFakeServer();
    configurePlugin(
      {
        aivisBaseUrl: 'not-a-url',
        playcheckRoot: root,
        exhibitionCaptureEnabled: true,
      },
      fake.server,
    );
    const captureId = await waitForCaptureId(root);
    assert.equal(fake.handlers.length, 1);

    assert.equal(
      await postEvent(fake.handlers[0], {
        at: '2026-08-22T00:00:00.000Z',
        elapsedMs: 10,
        event: 'input_received',
        source: 'manual',
        turnId: 'turn-1',
      }),
      204,
    );

    const runId = 'pc-20260822-abcdef12';
    assert.equal(
      await postEvent(
        fake.handlers[0],
        {
          at: '2026-08-22T00:00:01.000Z',
          elapsedMs: 20,
          event: 'turn_completed',
          source: 'manual',
          turnId: 'turn-1',
        },
        { 'x-performer-run-id': runId },
      ),
      204,
    );
    assert.equal(
      await postEvent(fake.handlers[0], {
        at: '2026-08-22T00:00:02.000Z',
        elapsedMs: 30,
        event: 'autonomy_gate',
        source: 'autonomous',
        turnId: 'autonomy-gate-1',
        gateEvent: 'turn_completed',
        gatePhase: 'refractory',
        transition: 'entered_refractory',
        candidateEpisodeId: 'episode-1',
        candidateReasonIds: ['reason-1'],
        candidateEvidenceIds: ['evidence-1'],
        usedReasonIds: ['reason-1'],
        createdReasonIds: ['reason-2'],
        resolvedReasonIds: ['reason-1'],
        externalAction: 'speak',
        nextEligibleAt: 18_000,
        delayMs: 8_000,
        timingMode: 'monotonic',
        elapsedSilenceMs: 13_000,
        readiness: 0.25,
        threshold: 0.25,
        opportunityOutcome: 'fired',
        sessionGeneration: 2,
      }),
      204,
    );

    const events = await readExhibitionEvents(root, captureId);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'input_received');
    assert.equal(events[1].event, 'autonomy_gate');
    assert.deepEqual(events[1].usedReasonIds, ['reason-1']);
    assert.deepEqual(events[1].createdReasonIds, ['reason-2']);
    assert.deepEqual(events[1].resolvedReasonIds, ['reason-1']);
    assert.deepEqual(events[1].candidateEvidenceIds, ['evidence-1']);
    assert.equal(events[1].timingMode, 'monotonic');
    assert.equal(events[1].elapsedSilenceMs, 13_000);
    assert.equal(events[1].readiness, 0.25);
    assert.equal(events[1].threshold, 0.25);
    assert.equal(events[1].opportunityOutcome, 'fired');
    assert.equal(events[1].sessionGeneration, 2);
    assert.equal('message' in events[0], false);
    assert.equal('history' in events[0], false);
    assert.equal('apiKey' in events[0], false);
    assert.equal(
      (await readPlaycheckRecords(root, runId)).length,
      1,
    );

    fake.server.httpServer.emit('close');
    await waitForCaptureCompletion(root, captureId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normal local API configuration does not create exhibition files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-local-api-no-capture-'));
  try {
    const fake = createFakeServer();
    configurePlugin(
      {
        aivisBaseUrl: 'not-a-url',
        playcheckRoot: root,
        exhibitionCaptureEnabled: false,
      },
      fake.server,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await assert.rejects(
      readFile(join(root, 'exhibition'), 'utf8'),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
