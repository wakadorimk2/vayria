const SILENT_WAV_DURATION_MS = 100;
const SILENT_WAV_SAMPLE_RATE = 8_000;
export const STREAMING_PLAYBACK_START_TIMEOUT_MS = 1_000;

export async function resumeAudioContext(context: AudioContext, timeoutMs = STREAMING_PLAYBACK_START_TIMEOUT_MS): Promise<boolean> {
  if (context.state === 'running') return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      context.resume().then(() => context.state === 'running', () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function createSilentWavBytes(): Uint8Array {
  const sampleCount = Math.round(
    (SILENT_WAV_SAMPLE_RATE * SILENT_WAV_DURATION_MS) / 1_000,
  );
  const dataByteLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);
  return bytes;
}

function createSilentWavDataUrl(): string {
  const bytes = createSilentWavBytes();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export type StreamingAudioElementFactory = () => HTMLAudioElement;

export function isPlaybackGestureError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'NotAllowedError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'NotAllowedError')
  );
}

export type PlaybackGestureReason = 'not_allowed' | 'start_timeout';
export type PlaybackStartOutcome = 'started' | PlaybackGestureReason;

export function monitorPlaybackStart(
  playPromise: Promise<void>,
  playingPromise: Promise<void>,
  timeoutMs = STREAMING_PLAYBACK_START_TIMEOUT_MS,
  interrupted?: Promise<never>,
): Promise<PlaybackStartOutcome> {
  const playOutcome = playPromise.then<
    PlaybackStartOutcome,
    PlaybackStartOutcome
  >(
    () => 'started',
    (error) => {
      if (isPlaybackGestureError(error)) return 'not_allowed';
      throw error;
    },
  );
  const playingOutcome = playingPromise.then<PlaybackStartOutcome>(
    () => 'started',
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<PlaybackStartOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('start_timeout'), timeoutMs);
  });
  return Promise.race([
    playOutcome,
    playingOutcome,
    timeout,
    ...(interrupted ? [interrupted] : []),
  ]).finally(() => {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  });
}

export class PlaybackGestureGate {
  private cancelled = false;
  private completed = false;
  private completion: Promise<void> | null = null;
  private rejectCompletion: ((error: unknown) => void) | null = null;
  private resolveCompletion: (() => void) | null = null;
  private resumePromise: Promise<boolean> | null = null;

  get isWaiting(): boolean {
    return this.completion !== null;
  }

  wait(): Promise<void> {
    if (!this.completion) {
      this.cancelled = false;
      this.completed = false;
      this.completion = new Promise<void>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
    }
    return this.completion;
  }

  resume(attempt: () => Promise<boolean>): Promise<boolean> {
    if (!this.completion) return Promise.resolve(false);
    if (this.resumePromise) return this.resumePromise;

    const resumePromise = attempt()
      .then((ready) => {
        if (!ready || this.cancelled) return false;
        if (!this.completed) this.complete();
        return true;
      })
      .finally(() => {
        if (this.resumePromise === resumePromise) this.resumePromise = null;
      });
    this.resumePromise = resumePromise;
    return resumePromise;
  }

  cancel(error: unknown): void {
    if (!this.completion) return;
    this.cancelled = true;
    this.rejectCompletion?.(error);
    this.clear();
  }

  complete(): void {
    if (!this.completion) return;
    this.completed = true;
    this.resolveCompletion?.();
    this.clear();
  }

  private clear(): void {
    this.completion = null;
    this.rejectCompletion = null;
    this.resolveCompletion = null;
  }
}

export class PersistentStreamingAudio {
  private audioElement: HTMLAudioElement | null = null;
  private elementSource: MediaElementAudioSourceNode | null = null;
  private sourceContext: AudioContext | null = null;
  private unlocked = false;
  private preparationGeneration = 0;
  private pendingPreparation: Promise<boolean> | null = null;
  private hasPlaybackSource = false;

  constructor(
    private readonly createAudioElement: StreamingAudioElementFactory = () =>
      new Audio(),
  ) {}

  ensure(context: AudioContext): {
    audio: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
  } {
    if (this.sourceContext && this.sourceContext !== context) {
      this.dispose();
    }

    if (!this.audioElement) {
      const audio = this.createAudioElement();
      audio.disableRemotePlayback = true;
      audio.preload = 'auto';
      this.audioElement = audio;
    }

    if (!this.elementSource) {
      this.elementSource = context.createMediaElementSource(this.audioElement);
      this.sourceContext = context;
    }

    return { audio: this.audioElement, source: this.elementSource };
  }

  prepare(
    context: AudioContext,
    resumeActiveSource: boolean,
    timeoutMs = STREAMING_PLAYBACK_START_TIMEOUT_MS,
  ): Promise<boolean> {
    const { audio } = this.ensure(context);
    if (this.pendingPreparation) return this.pendingPreparation;
    resumeActiveSource = resumeActiveSource || this.hasPlaybackSource;
    const generation = ++this.preparationGeneration;
    const current = () => generation === this.preparationGeneration;
    const contextReady = resumeAudioContext(context, timeoutMs);

    let readiness: Promise<boolean>;
    if (!resumeActiveSource && this.unlocked) {
      readiness = contextReady
        .then(() => context.state === 'running')
        .catch(() => false);
    } else {
      const usesSilentSource = !resumeActiveSource;
      if (usesSilentSource) {
        audio.pause();
        audio.src = createSilentWavDataUrl();
        audio.load();
      }

      // Both operations must start before the first await to preserve user activation.
      let audioReady: Promise<void>;
      try { audioReady = audio.play(); }
      catch { audioReady = Promise.reject(new Error('Audio preparation failed.')); }
      readiness = Promise.all([contextReady, audioReady])
        .then(([contextRunning]) => {
          if (!current() || !contextRunning) return false;
          this.unlocked = true;
          if (usesSilentSource) this.clearElementSource();
          return context.state === 'running';
        })
        .catch(() => {
          if (current() && usesSilentSource) this.clearElementSource();
          return false;
        });
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve(false),
        timeoutMs,
      );
    });
    const pending = Promise.race([readiness, timeout]).then(ready => current() && ready).finally(() => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (current()) {
        if (!resumeActiveSource && !this.unlocked) this.clearElementSource();
        this.preparationGeneration += 1;
      }
      if (this.pendingPreparation === pending) this.pendingPreparation = null;
    });
    this.pendingPreparation = pending;
    return pending;
  }

  setSource(url: string): HTMLAudioElement {
    if (!this.audioElement) {
      throw new Error('Streaming audio element is not initialized.');
    }
    this.clearSource();
    this.audioElement.src = url;
    this.hasPlaybackSource = true;
    return this.audioElement;
  }

  clearSource(): void {
    this.preparationGeneration += 1;
    this.pendingPreparation = null;
    this.hasPlaybackSource = false;
    this.clearElementSource();
  }

  private clearElementSource(): void {
    if (!this.audioElement) return;
    this.audioElement.pause();
    this.audioElement.removeAttribute('src');
    this.audioElement.load();
  }

  disconnect(): void {
    this.elementSource?.disconnect();
  }

  dispose(): void {
    this.clearSource();
    this.elementSource?.disconnect();
    this.elementSource = null;
    this.audioElement = null;
    this.sourceContext = null;
    this.unlocked = false;
  }
}
