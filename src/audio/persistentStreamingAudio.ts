const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAA';

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

export class PlaybackGestureGate {
  private completion: Promise<void> | null = null;
  private rejectCompletion: ((error: unknown) => void) | null = null;
  private resolveCompletion: (() => void) | null = null;
  private resumePromise: Promise<boolean> | null = null;

  get isWaiting(): boolean {
    return this.completion !== null;
  }

  wait(): Promise<void> {
    if (!this.completion) {
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
        if (!ready || this.completion === null) return false;
        this.resolveCompletion?.();
        this.clear();
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
    this.rejectCompletion?.(error);
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

  prepare(context: AudioContext, resumeActiveSource: boolean): Promise<boolean> {
    const { audio } = this.ensure(context);
    const contextReady =
      context.state === 'running' ? Promise.resolve() : context.resume();

    if (!resumeActiveSource && this.unlocked) {
      return contextReady
        .then(() => context.state === 'running')
        .catch(() => false);
    }

    const usesSilentSource = !resumeActiveSource;
    if (usesSilentSource) {
      audio.pause();
      audio.src = SILENT_WAV_DATA_URL;
      audio.load();
    }

    // Both operations must start before the first await to preserve user activation.
    const audioReady = audio.play();
    return Promise.all([contextReady, audioReady])
      .then(() => {
        this.unlocked = true;
        if (usesSilentSource) this.clearSource();
        return context.state === 'running';
      })
      .catch(() => {
        if (usesSilentSource) this.clearSource();
        return false;
      });
  }

  setSource(url: string): HTMLAudioElement {
    if (!this.audioElement) {
      throw new Error('Streaming audio element is not initialized.');
    }
    this.clearSource();
    this.audioElement.src = url;
    return this.audioElement;
  }

  clearSource(): void {
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
