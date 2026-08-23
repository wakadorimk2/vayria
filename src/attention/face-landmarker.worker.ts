import {
  FaceLandmarker,
  FilesetResolver,
} from '@mediapipe/tasks-vision';
import { normalizeFaceBounds } from './attentionMath.js';
import type {
  FaceLandmarkerWorkerRequest,
  FaceLandmarkerWorkerResponse,
} from './faceLandmarkerProtocol.js';

type WorkerScope = {
  onmessage: ((event: MessageEvent<FaceLandmarkerWorkerRequest>) => void) | null;
  postMessage(message: FaceLandmarkerWorkerResponse): void;
};

const workerScope = globalThis as unknown as WorkerScope;
let faceLandmarker: FaceLandmarker | null = null;

workerScope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(
  request: FaceLandmarkerWorkerRequest,
): Promise<void> {
  if (request.type === 'init') {
    await initializeFaceLandmarker(request);
    return;
  }

  if (request.type === 'close') {
    faceLandmarker?.close();
    faceLandmarker = null;
    return;
  }

  if (!faceLandmarker) {
    request.frame.close();
    workerScope.postMessage({ type: 'error', code: 'worker-failed' });
    return;
  }

  try {
    const result = faceLandmarker.detectForVideo(
      request.frame,
      request.timestamp,
    );
    request.frame.close();
    workerScope.postMessage({
      type: 'result',
      position: normalizeFaceBounds(result.faceLandmarks[0] ?? []),
    });
  } catch {
    request.frame.close();
    workerScope.postMessage({ type: 'error', code: 'worker-failed' });
  }
}

async function initializeFaceLandmarker(
  request: Extract<FaceLandmarkerWorkerRequest, { type: 'init' }>,
): Promise<void> {
  try {
    faceLandmarker?.close();
    // This Worker is an ES module. Use MediaPipe's module WASM assets.
    const wasmFileset = await FilesetResolver.forVisionTasks(
      request.wasmBasePath,
      true,
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
      baseOptions: {
        delegate: 'CPU',
        modelAssetPath: request.modelAssetPath,
      },
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      runningMode: 'VIDEO',
    });
    workerScope.postMessage({ type: 'ready' });
  } catch {
    faceLandmarker = null;
    workerScope.postMessage({ type: 'error', code: 'model-failed' });
  }
}
