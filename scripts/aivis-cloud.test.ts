import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AivisCloudError,
  synthesizeAivisCloudSpeech,
} from '../server/tts/aivisCloud.js';

const MODEL_UUID = '11111111-2222-4333-8444-555555555555';

function createInput(fetchImpl: typeof fetch) {
  return {
    apiKey: 'cloud-secret-test-key',
    baseUrl: 'https://cloud.example.test',
    emotionalIntensity: 0.8,
    fetchImpl,
    modelUuid: MODEL_UUID,
    pitch: 0,
    speakingRate: 1.15,
    styleName: 'B',
    tempoDynamics: 1.2,
    text: '秘密にしないテスト本文',
    timeoutMs: 1_000,
  };
}

test('Cloud synthesis sends the documented safe MP3 request and streams chunks', async () => {
  let request: { init?: RequestInit; url?: string } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    request = { init, url: String(input) };
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    );
  };

  const result = await synthesizeAivisCloudSpeech(createInput(fetchImpl));
  const reader = result.body.getReader();
  const first = await reader.read();
  const second = await reader.read();
  result.dispose();

  assert.equal(request.url, 'https://cloud.example.test/v1/tts/synthesize');
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer cloud-secret-test-key');
  assert.equal(headers.get('Accept'), 'audio/mpeg');
  const body = JSON.parse(String(request.init?.body));
  assert.deepEqual(body, {
    model_uuid: MODEL_UUID,
    text: '秘密にしないテスト本文',
    use_ssml: false,
    style_name: 'B',
    speaking_rate: 1.15,
    emotional_intensity: 0.8,
    tempo_dynamics: 1.2,
    pitch: 0,
    leading_silence_seconds: 0,
    output_format: 'mp3',
    output_bitrate: 192,
    output_sampling_rate: 44_100,
    output_audio_channels: 'mono',
  });
  assert.deepEqual([...first.value!], [1, 2]);
  assert.deepEqual([...second.value!], [3]);
});

test('Cloud synthesis requires a key and model UUID without calling fetch', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response();
  };
  await assert.rejects(
    synthesizeAivisCloudSpeech({ ...createInput(fetchImpl), apiKey: '' }),
    (error: unknown) =>
      error instanceof AivisCloudError && error.kind === 'configuration',
  );
  await assert.rejects(
    synthesizeAivisCloudSpeech({ ...createInput(fetchImpl), modelUuid: 'bad' }),
    (error: unknown) =>
      error instanceof AivisCloudError && error.kind === 'configuration',
  );
  assert.equal(calls, 0);
});

for (const [status, kind] of [
  [401, 'authentication'],
  [402, 'quota'],
  [404, 'model'],
  [422, 'invalid_request'],
  [429, 'rate_limit'],
  [503, 'provider'],
] as const) {
  test(`Cloud synthesis maps HTTP ${status} without reading an upstream body`, async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('sensitive upstream detail', { status });
    await assert.rejects(
      synthesizeAivisCloudSpeech(createInput(fetchImpl)),
      (error: unknown) =>
        error instanceof AivisCloudError &&
        error.kind === kind &&
        !error.message.includes('sensitive upstream detail'),
    );
  });
}

test('Cloud synthesis aborts a request after the bounded timeout', async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
    });
  await assert.rejects(
    synthesizeAivisCloudSpeech({ ...createInput(fetchImpl), timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof AivisCloudError && error.kind === 'timeout',
  );
});

test('Cloud synthesis applies the first-audio timeout while the stream is silent', async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    );
  const result = await synthesizeAivisCloudSpeech({
    ...createInput(fetchImpl),
    firstAudioTimeoutMs: 5,
  });

  await assert.rejects(result.body.getReader().read());
  assert.equal(result.timeoutKind(), 'first_audio_timeout');
  result.dispose();
});

test('Cloud synthesis clears only the first-audio timer after audio arrives', async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    );
  const result = await synthesizeAivisCloudSpeech({
    ...createInput(fetchImpl),
    firstAudioTimeoutMs: 5,
    timeoutMs: 20,
  });
  const reader = result.body.getReader();
  assert.deepEqual([...(await reader.read()).value!], [1]);
  result.markFirstAudioReceived();

  await assert.rejects(reader.read());
  assert.equal(result.timeoutKind(), 'timeout');
  result.dispose();
});

test('Cloud synthesis maps a caller abort without converting it to a timeout', async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
    });
  const synthesis = synthesizeAivisCloudSpeech({
    ...createInput(fetchImpl),
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    synthesis,
    (error: unknown) =>
      error instanceof AivisCloudError && error.kind === 'aborted',
  );
});

test('Cloud synthesis keeps the timeout active while the audio stream is open', async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
    );
  const result = await synthesizeAivisCloudSpeech({
    ...createInput(fetchImpl),
    timeoutMs: 5,
  });

  await assert.rejects(result.body.getReader().read());
  assert.equal(result.didTimeout(), true);
  result.dispose();
});
