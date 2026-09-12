// Coordinate microphone ownership across a complete reply and its audio chunks.
export interface MicrophoneCapture {
  pause(): Promise<void>;
  resume(): Promise<boolean>;
}

export function isIosDevice(device: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/.test(device.userAgent) || (device.platform === 'MacIntel' && device.maxTouchPoints > 1);
}

export class IosAudioSession {
  private capture: MicrophoneCapture | null = null;
  private holds = new Set<symbol>();
  private recordingHolds = new Set<symbol>();
  private ready: Promise<void> = Promise.resolve();
  private cycle = 0;
  constructor(private readonly setType: (type: 'playback' | 'play-and-record') => void) {}

  get playbackHeld(): boolean { return this.holds.size > 0; }

  register(capture: MicrophoneCapture): () => void {
    this.capture = capture;
    return () => { if (this.capture === capture) { this.capture = null; this.playback(); } };
  }

  recording(): void { if (!this.playbackHeld) this.setType('play-and-record'); }
  playback(): void { if (!this.recordingHolds.size) this.setType('playback'); }

  // Full-duplex conversations must remain record-capable across remote playback.
  holdRecording(): () => void {
    const token = Symbol();
    this.recordingHolds.add(token);
    this.setType('play-and-record');
    return () => {
      if (this.recordingHolds.delete(token) && !this.recordingHolds.size) this.playback();
    };
  }

  holdPlayback(): { ready: Promise<void>; release: () => void } {
    const token = Symbol();
    this.holds.add(token);
    if (this.holds.size === 1) {
      this.cycle += 1;
      // pause() stops tracks synchronously before awaiting AudioContext.close().
      const paused = this.capture?.pause() ?? Promise.resolve();
      this.ready = Promise.all([this.ready.catch(() => undefined), paused]).then(() => { if (this.playbackHeld) this.playback(); });
    }
    const ready = this.ready;
    const cycle = this.cycle;
    // A turn-wide hold can precede an audio hold. Consume rejection until audio awaits it.
    void ready.catch(() => undefined);
    return { ready, release: () => {
      if (!this.holds.delete(token) || this.playbackHeld) return;
      void ready.then(async () => {
        if (this.playbackHeld || cycle !== this.cycle) return;
        await this.capture?.resume();
      }).catch(() => undefined);
    } };
  }
}

let session: IosAudioSession | null = null;
export function getIosAudioSession(): IosAudioSession | null {
  if (typeof navigator === 'undefined' || !isIosDevice(navigator)) return null;
  session ??= new IosAudioSession(type => {
    const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    try { if (audioSession) audioSession.type = type; }
    catch { /* Unsupported categories must not prevent playback or track release. */ }
  });
  return session;
}
