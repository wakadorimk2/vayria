import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  CameraAttentionController,
} from '../src/attention/cameraAttentionController.js';
import type { FaceLandmarkerWorkerResponse } from '../src/attention/faceLandmarkerProtocol.js';

interface TestWorker {
  onmessage: ((event: MessageEvent<FaceLandmarkerWorkerResponse>) => void) | null;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
  terminated: boolean;
}

let previousWindow: unknown;

beforeEach(() => {
  previousWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    clearTimeout,
    isSecureContext: true,
    setTimeout,
  };
});

afterEach(() => {
  if (previousWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = previousWindow;
  }
});

test('permission denial becomes retryable without retaining a stream', async () => {
  const controller = new CameraAttentionController({
    createImageBitmap: async () => createFakeImageBitmap(),
    getUserMedia: async () => {
      throw new DOMException('permission denied', 'NotAllowedError');
    },
    isSecureContext: () => true,
  });

  assert.equal(await controller.start(), false);
  assert.deepEqual(controller.getState(), {
    status: 'denied',
    errorCode: 'permission-denied',
  });
  assert.equal(controller.readSnapshot().position, null);
});

test('concurrent starts share one pending camera startup', async () => {
  let resolveStream!: (stream: MediaStream) => void;
  let getUserMediaCalls = 0;
  let stoppedTracks = 0;
  const controller = new CameraAttentionController({
    createAssetUrl: (path) => `https://example.test/${path}`,
    createImageBitmap: async () => createFakeImageBitmap(),
    createVideo: () => createFakeVideo(),
    createWorker: () => createFakeWorker({ type: 'ready' }) as unknown as Worker,
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      return new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      });
    },
    isSecureContext: () => true,
  });

  const firstStart = controller.start();
  assert.equal(controller.getState().status, 'starting');
  const secondStart = controller.start();

  assert.strictEqual(secondStart, firstStart);
  assert.equal(getUserMediaCalls, 1);

  resolveStream(createFakeStream(() => stoppedTracks++));
  assert.equal(await firstStart, true);
  controller.stop();
  assert.equal(stoppedTracks, 1);
});

test('worker failure returns to the existing gaze path and releases the stream', async () => {
  let stoppedTracks = 0;
  const workerRef: { current: TestWorker | null } = { current: null };
  const controller = new CameraAttentionController({
    createAssetUrl: (path) => `https://example.test/${path}`,
    createImageBitmap: async () => createFakeImageBitmap(),
    createVideo: () => createFakeVideo(),
    createWorker: () => {
      workerRef.current = createFakeWorker({
        type: 'error',
        code: 'worker-failed',
      });
      return workerRef.current as unknown as Worker;
    },
    getUserMedia: async () => createFakeStream(() => stoppedTracks++),
    isSecureContext: () => true,
  });

  assert.equal(await controller.start(), false);
  assert.deepEqual(controller.getState(), {
    status: 'error',
    errorCode: 'worker-failed',
  });
  assert.equal(stoppedTracks, 1);
  assert.equal(workerRef.current?.terminated, true);
});

test('stop releases camera tracks after the worker becomes active', async () => {
  let stoppedTracks = 0;
  const workerRef: { current: TestWorker | null } = { current: null };
  const controller = new CameraAttentionController({
    createAssetUrl: (path) => `https://example.test/${path}`,
    createImageBitmap: async () => createFakeImageBitmap(),
    createVideo: () => createFakeVideo(),
    createWorker: () => {
      workerRef.current = createFakeWorker({ type: 'ready' });
      return workerRef.current as unknown as Worker;
    },
    getUserMedia: async () => createFakeStream(() => stoppedTracks++),
    isSecureContext: () => true,
  });

  assert.equal(await controller.start(), true);
  assert.equal(controller.getState().status, 'active');
  controller.stop();
  assert.equal(controller.getState().status, 'idle');
  assert.equal(stoppedTracks, 1);
  assert.equal(workerRef.current?.terminated, true);
});

test('worker face positions are mirrored before the snapshot is published', async () => {
  const workerRef: { current: TestWorker | null } = { current: null };
  const controller = new CameraAttentionController({
    createAssetUrl: (path) => `https://example.test/${path}`,
    createImageBitmap: async () => createFakeImageBitmap(),
    createVideo: () => createFakeVideo(),
    createWorker: () => {
      workerRef.current = createFakeWorker({ type: 'ready' });
      return workerRef.current as unknown as Worker;
    },
    getUserMedia: async () => createFakeStream(() => {}),
    isSecureContext: () => true,
  });

  assert.equal(await controller.start(), true);
  workerRef.current?.onmessage?.({
    data: { type: 'result', position: { x: 0.2, y: 0.4 } },
  } as MessageEvent<FaceLandmarkerWorkerResponse>);

  const snapshot = controller.readSnapshot();
  assert.ok(snapshot.position);
  assert.ok(Math.abs(snapshot.position.x - 0.8) < 0.000001);
  assert.equal(snapshot.position.y, 0.4);
  controller.stop();
});

test('a missing face result keeps the last position until tracking decides to release it', async () => {
  const workerRef: { current: TestWorker | null } = { current: null };
  const controller = new CameraAttentionController({
    createAssetUrl: (path) => `https://example.test/${path}`,
    createImageBitmap: async () => createFakeImageBitmap(),
    createVideo: () => createFakeVideo(),
    createWorker: () => {
      workerRef.current = createFakeWorker({ type: 'ready' });
      return workerRef.current as unknown as Worker;
    },
    getUserMedia: async () => createFakeStream(() => {}),
    isSecureContext: () => true,
  });

  assert.equal(await controller.start(), true);
  workerRef.current?.onmessage?.({
    data: { type: 'result', position: { x: 0.2, y: 0.4 } },
  } as MessageEvent<FaceLandmarkerWorkerResponse>);
  const trackedPosition = controller.readSnapshot().position;

  workerRef.current?.onmessage?.({
    data: { type: 'result', position: null },
  } as MessageEvent<FaceLandmarkerWorkerResponse>);
  const missingSnapshot = controller.readSnapshot();

  assert.deepEqual(missingSnapshot.position, trackedPosition);
  assert.equal(missingSnapshot.confidence, 0);
  controller.stop();
});

function createFakeWorker(response: FaceLandmarkerWorkerResponse): TestWorker {
  const worker: TestWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message: unknown) {
      if ((message as { type?: string }).type !== 'init') return;
      queueMicrotask(() => {
        worker.onmessage?.({ data: response } as MessageEvent<FaceLandmarkerWorkerResponse>);
      });
    },
    terminate() {
      worker.terminated = true;
    },
    terminated: false,
  };
  return worker;
}

function createFakeImageBitmap(): ImageBitmap {
  return { close() {} } as ImageBitmap;
}

function createFakeVideo(): HTMLVideoElement {
  return {
    autoplay: false,
    muted: false,
    pause() {},
    playsInline: false,
    play: async () => {},
    readyState: 4,
    srcObject: null,
  } as unknown as HTMLVideoElement;
}

function createFakeStream(onStop: () => void): MediaStream {
  return {
    getTracks: () => [{ stop: onStop } as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}
