import type { AttentionPosition } from '../performer/types.js';
import {
  applyPositionDeadZone,
  CAMERA_ATTENTION_CONFIG,
  clampAttentionPosition,
  invertHorizontalAttentionPosition,
  smoothAttentionPosition,
} from './attentionMath.js';
import type {
  FaceLandmarkerWorkerRequest,
  FaceLandmarkerWorkerResponse,
} from './faceLandmarkerProtocol.js';

export type CameraAttentionStatus =
  | 'idle'
  | 'starting'
  | 'active'
  | 'denied'
  | 'unsupported'
  | 'error';

export type CameraAttentionErrorCode =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'camera-failed'
  | 'model-failed'
  | 'worker-failed';

export interface CameraAttentionSnapshot {
  position: AttentionPosition | null;
  confidence: number;
  updatedAt: number;
}

export interface CameraAttentionControllerState {
  status: CameraAttentionStatus;
  errorCode: CameraAttentionErrorCode | null;
}

export interface CameraAttentionControllerOptions {
  onStateChange?: (state: CameraAttentionControllerState) => void;
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  createVideo?: () => HTMLVideoElement;
  createWorker?: () => Worker;
  createImageBitmap?: (source: ImageBitmapSource) => Promise<ImageBitmap>;
  isSecureContext?: () => boolean;
  createAssetUrl?: (path: string) => string;
}

const EMPTY_SNAPSHOT: CameraAttentionSnapshot = {
  position: null,
  confidence: 0,
  updatedAt: 0,
};

export class CameraAttentionController {
  private readonly onStateChange?:
    CameraAttentionControllerOptions['onStateChange'];
  private readonly getUserMedia: NonNullable<
    CameraAttentionControllerOptions['getUserMedia']
  >;
  private readonly hasCustomGetUserMedia: boolean;
  private readonly createVideo: NonNullable<
    CameraAttentionControllerOptions['createVideo']
  >;
  private readonly createWorker: NonNullable<
    CameraAttentionControllerOptions['createWorker']
  >;
  private readonly createImageBitmapFactory:
    CameraAttentionControllerOptions['createImageBitmap'] | null;
  private readonly isSecureContext: () => boolean;
  private readonly createAssetUrl: (path: string) => string;
  private state: CameraAttentionControllerState = {
    status: 'idle',
    errorCode: null,
  };
  private snapshot: CameraAttentionSnapshot = { ...EMPTY_SNAPSHOT };
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private frameTimer: number | null = null;
  private workerBusy = false;
  private lastSubmittedAt = Number.NEGATIVE_INFINITY;
  private lastTargetPosition: AttentionPosition | null = null;
  private generation = 0;
  private startPromise: Promise<boolean> | null = null;
  private readyResolver: ((ready: boolean) => void) | null = null;
  private readyTimeout: number | null = null;

  constructor(options: CameraAttentionControllerOptions = {}) {
    this.onStateChange = options.onStateChange;
    this.hasCustomGetUserMedia = options.getUserMedia !== undefined;
    this.getUserMedia =
      options.getUserMedia ??
      ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.createVideo =
      options.createVideo ?? (() => document.createElement('video'));
    this.createWorker =
      options.createWorker ??
      (() => {
        if (typeof Worker !== 'function') {
          throw new Error('worker-unsupported');
        }
        return new Worker(
          new URL('./face-landmarker.worker.ts', import.meta.url),
          { type: 'module' },
        );
      });
    this.createImageBitmapFactory =
      options.createImageBitmap ??
      (typeof globalThis.createImageBitmap === 'function'
        ? globalThis.createImageBitmap.bind(globalThis)
        : null);
    this.isSecureContext =
      options.isSecureContext ?? (() => window.isSecureContext);
    this.createAssetUrl =
      options.createAssetUrl ?? ((path) => createPublicAssetUrl(path));
  }

  getState(): CameraAttentionControllerState {
    return this.state;
  }

  readSnapshot(): CameraAttentionSnapshot {
    return this.snapshot;
  }

  start(): Promise<boolean> {
    if (this.state.status === 'active') return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  stop(): void {
    this.generation += 1;
    this.resolveReady(false);
    this.clearFrameTimer();
    if (this.readyTimeout !== null) {
      window.clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    this.worker?.postMessage({ type: 'close' } satisfies FaceLandmarkerWorkerRequest);
    this.worker?.terminate();
    this.worker = null;
    this.workerBusy = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
    this.snapshot = { ...EMPTY_SNAPSHOT, updatedAt: Date.now() };
    this.lastTargetPosition = null;
    this.setState('idle', null);
  }

  private async startInternal(): Promise<boolean> {
    const generation = ++this.generation;
    this.setState('starting', null);

    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return this.fail(generation, 'unsupported');
    }
    if (!this.isSecureContext()) {
      return this.fail(generation, 'insecure-context');
    }
    if (!this.hasCustomGetUserMedia && !navigator.mediaDevices?.getUserMedia) {
      return this.fail(generation, 'unsupported');
    }
    if (!this.createImageBitmapFactory) {
      return this.fail(generation, 'camera-failed');
    }

    try {
      const stream = await this.getUserMedia({
        audio: false,
        video: { facingMode: 'user' },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const video = this.createVideo();
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      this.stream = stream;
      this.video = video;
      await video.play();

      if (generation !== this.generation) return false;

      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch {
        return this.fail(generation, 'worker-failed');
      }
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<FaceLandmarkerWorkerResponse>) => {
        this.handleWorkerMessage(generation, event.data);
      };
      worker.onerror = () => {
        this.fail(generation, 'worker-failed');
      };
      worker.onmessageerror = () => {
        this.fail(generation, 'worker-failed');
      };
      worker.postMessage({
        type: 'init',
        modelAssetPath: this.createAssetUrl('attention/face_landmarker.task'),
        wasmBasePath: this.createAssetUrl('attention/wasm/'),
      } satisfies FaceLandmarkerWorkerRequest);

      const ready = new Promise<boolean>((resolve) => {
        this.readyResolver = resolve;
      });
      this.readyTimeout = window.setTimeout(() => {
        this.fail(generation, 'model-failed');
      }, 15_000);
      return await ready;
    } catch (error) {
      return this.fail(generation, classifyCameraError(error));
    }
  }

  private handleWorkerMessage(
    generation: number,
    message: FaceLandmarkerWorkerResponse,
  ): void {
    if (generation !== this.generation) return;

    if (message.type === 'ready') {
      if (this.readyTimeout !== null) {
        window.clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.setState('active', null);
      this.resolveReady(true);
      this.scheduleCapture(generation);
      return;
    }

    if (message.type === 'error') {
      this.fail(generation, message.code);
      return;
    }

    this.workerBusy = false;
    const now = Date.now();
    if (message.position) {
      // Exhibition iPad attention uses real-world horizontal direction.
      // Apply the front-camera mirror correction exactly once at this boundary.
      const correctedPosition = invertHorizontalAttentionPosition(
        message.position,
      );
      const nextTarget = applyPositionDeadZone(
        clampAttentionPosition(correctedPosition),
        this.lastTargetPosition,
      );
      const elapsedMs =
        this.snapshot.updatedAt === 0
          ? CAMERA_ATTENTION_CONFIG.smoothingMs
          : Math.max(0, now - this.snapshot.updatedAt);
      this.lastTargetPosition = nextTarget;
      this.snapshot = {
        position: smoothAttentionPosition(
          this.snapshot.position,
          nextTarget,
          elapsedMs,
        ),
        confidence: 1,
        updatedAt: now,
      };
    } else {
      this.snapshot = {
        ...this.snapshot,
        confidence: 0,
        updatedAt: now,
      };
    }
    this.scheduleCapture(generation);
  }

  private async captureFrame(generation: number): Promise<void> {
    this.frameTimer = null;
    const video = this.video;
    const worker = this.worker;
    if (
      generation !== this.generation ||
      this.state.status !== 'active' ||
      !video ||
      !worker ||
      this.workerBusy
    ) {
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.scheduleCapture(generation);
      return;
    }

    try {
      const createImageBitmapFactory = this.createImageBitmapFactory;
      if (!createImageBitmapFactory) {
        this.fail(generation, 'camera-failed');
        return;
      }
      const frame = await createImageBitmapFactory(video);
      if (generation !== this.generation || this.state.status !== 'active') {
        frame.close();
        return;
      }
      this.workerBusy = true;
      this.lastSubmittedAt = performance.now();
      worker.postMessage(
        {
          type: 'detect',
          frame,
          timestamp: this.lastSubmittedAt,
        } satisfies FaceLandmarkerWorkerRequest,
        [frame],
      );
    } catch {
      this.fail(generation, 'camera-failed');
    }
  }

  private scheduleCapture(generation: number): void {
    if (
      this.frameTimer !== null ||
      this.workerBusy ||
      generation !== this.generation ||
      this.state.status !== 'active'
    ) {
      return;
    }
    const elapsedMs = performance.now() - this.lastSubmittedAt;
    const waitMs = Math.max(
      0,
      CAMERA_ATTENTION_CONFIG.inferenceIntervalMs - elapsedMs,
    );
    this.frameTimer = window.setTimeout(() => {
      void this.captureFrame(generation);
    }, waitMs);
  }

  private fail(
    generation: number,
    errorCode: CameraAttentionErrorCode,
  ): boolean {
    if (generation !== this.generation) return false;
    this.generation += 1;
    this.clearFrameTimer();
    if (this.readyTimeout !== null) {
      window.clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    this.resolveReady(false);
    this.worker?.terminate();
    this.worker = null;
    this.workerBusy = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
    this.snapshot = { ...EMPTY_SNAPSHOT, updatedAt: Date.now() };
    this.lastTargetPosition = null;
    const status =
      errorCode === 'permission-denied'
        ? 'denied'
        : errorCode === 'unsupported' || errorCode === 'insecure-context'
          ? 'unsupported'
          : 'error';
    this.setState(status, errorCode);
    return false;
  }

  private resolveReady(value: boolean): void {
    const resolver = this.readyResolver;
    this.readyResolver = null;
    resolver?.(value);
  }

  private clearFrameTimer(): void {
    if (this.frameTimer === null) return;
    window.clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  private setState(
    status: CameraAttentionStatus,
    errorCode: CameraAttentionErrorCode | null,
  ): void {
    this.state = { status, errorCode };
    this.onStateChange?.(this.state);
  }
}

function createPublicAssetUrl(path: string): string {
  const baseDocumentUrl =
    typeof document !== 'undefined' ? document.baseURI : window.location.href;
  const baseUrl = new URL(baseDocumentUrl);
  return new URL(path, baseUrl).href;
}

function classifyCameraError(error: unknown): CameraAttentionErrorCode {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
  ) {
    return 'permission-denied';
  }
  return 'camera-failed';
}
