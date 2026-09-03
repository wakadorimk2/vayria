export interface MediaSourceStreamTarget {
  addChunk(chunk: Uint8Array): void;
  end(): void;
  getBufferedDurationMs(): number;
  isUpdating(): boolean;
  waitForUpdate(): Promise<void>;
}

export type StreamingPlaybackPrimingReason =
  | 'target'
  | 'complete'
  | 'timeout'
  | 'cancelled';

export interface StreamingPlaybackPrimingResult {
  bufferedDurationMs: number;
  reason: StreamingPlaybackPrimingReason;
  waitedMs: number;
}

export interface StreamingPlaybackPrimingClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export class StreamingPlaybackPrimingGate {
  private bufferedDurationMs = 0;
  private firstChunkAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly promise: Promise<StreamingPlaybackPrimingResult>;
  private resolve!: (result: StreamingPlaybackPrimingResult) => void;
  private settled = false;

  constructor(
    private readonly targetMs: number,
    private readonly maximumWaitMs: number,
    private readonly clock: StreamingPlaybackPrimingClock = {
      now: () => performance.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  ) {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  observe(bufferedDurationMs: number, at = this.clock.now()): void {
    if (this.settled) return;
    this.bufferedDurationMs = Math.max(
      this.bufferedDurationMs,
      normalizeDuration(bufferedDurationMs),
    );
    if (this.firstChunkAt === null) {
      this.firstChunkAt = at;
      this.timer = this.clock.setTimeout(
        () => this.finish('timeout', this.clock.now()),
        normalizeDuration(this.maximumWaitMs),
      );
    }
    if (this.bufferedDurationMs >= normalizeDuration(this.targetMs)) {
      this.finish('target', at);
    }
  }

  complete(at = this.clock.now()): void {
    this.finish('complete', at);
  }

  cancel(at = this.clock.now()): void {
    this.finish('cancelled', at);
  }

  wait(): Promise<StreamingPlaybackPrimingResult> {
    return this.promise;
  }

  private finish(reason: StreamingPlaybackPrimingReason, at: number): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolve({
      bufferedDurationMs: Math.round(this.bufferedDurationMs),
      reason,
      waitedMs:
        this.firstChunkAt === null
          ? 0
          : Math.max(0, Math.round(at - this.firstChunkAt)),
    });
  }
}

function normalizeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function createMediaSourceStreamTarget(
  mediaSource: MediaSource,
  sourceBuffer: SourceBuffer,
): MediaSourceStreamTarget {
  const waitForUpdate = (): Promise<void> => {
    if (!sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
      sourceBuffer.addEventListener(
        'error',
        () => reject(new Error('Streaming audio buffer failed.')),
        { once: true },
      );
    });
  };

  return {
    addChunk: (chunk) => sourceBuffer.appendBuffer(new Uint8Array(chunk).buffer),
    end: () => {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    },
    getBufferedDurationMs: () => {
      const { buffered } = sourceBuffer;
      if (!buffered.length) return 0;
      try {
        return Math.max(0, (buffered.end(0) - buffered.start(0)) * 1_000);
      } catch {
        return 0;
      }
    },
    isUpdating: () => sourceBuffer.updating,
    waitForUpdate,
  };
}

export async function pumpMediaSourceAudio(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: MediaSourceStreamTarget,
  callbacks: {
    onChunk?: (chunk: Uint8Array) => void;
    onChunkAppended?: (chunk: Uint8Array, bufferedDurationMs: number) => void;
    onComplete?: () => void;
    onFirstChunk?: () => void;
  } = {},
): Promise<void> {
  let receivedAudio = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    callbacks.onChunk?.(value.slice());
    if (target.isUpdating()) await target.waitForUpdate();
    target.addChunk(value);
    await target.waitForUpdate();
    callbacks.onChunkAppended?.(value, target.getBufferedDurationMs());
    if (!receivedAudio) {
      receivedAudio = true;
      callbacks.onFirstChunk?.();
    }
  }
  if (!receivedAudio) throw new Error('Streaming audio response was empty.');
  if (target.isUpdating()) await target.waitForUpdate();
  target.end();
  callbacks.onComplete?.();
}
