export const RMS_ENVELOPE_WINDOW_MS = 20;
export const MAX_STREAMING_AUDIO_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface RmsEnvelope {
  durationSeconds: number;
  frameDurationSeconds: number;
  values: Float32Array;
}

interface AudioBufferSamples {
  duration: number;
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export function createRmsEnvelope(
  audio: AudioBufferSamples,
  windowMs = RMS_ENVELOPE_WINDOW_MS,
): RmsEnvelope {
  if (
    !Number.isFinite(audio.sampleRate) ||
    audio.sampleRate <= 0 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    audio.numberOfChannels <= 0
  ) {
    throw new Error('Decoded audio cannot be analysed.');
  }

  const frameSize = Math.max(1, Math.round(audio.sampleRate * windowMs / 1_000));
  const frameCount = Math.max(1, Math.ceil(audio.length / frameSize));
  const values = new Float32Array(frameCount);
  const channels = Array.from(
    { length: audio.numberOfChannels },
    (_, channel) => audio.getChannelData(channel),
  );

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(start + frameSize, audio.length);
    let squaredTotal = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      for (let index = start; index < end; index += 1) {
        const sample = channel[index] ?? 0;
        squaredTotal += sample * sample;
        sampleCount += 1;
      }
    }
    values[frame] = sampleCount > 0
      ? Math.sqrt(squaredTotal / sampleCount)
      : 0;
  }

  return {
    durationSeconds: Math.max(0, audio.duration),
    frameDurationSeconds: frameSize / audio.sampleRate,
    values,
  };
}

export function sampleRmsEnvelope(
  envelope: RmsEnvelope,
  playbackTimeSeconds: number,
): number {
  if (
    !Number.isFinite(playbackTimeSeconds) ||
    playbackTimeSeconds < 0 ||
    playbackTimeSeconds >= envelope.durationSeconds ||
    envelope.values.length === 0 ||
    envelope.frameDurationSeconds <= 0
  ) {
    return 0;
  }

  const position = Math.max(
    0,
    playbackTimeSeconds / envelope.frameDurationSeconds - 0.5,
  );
  const lowerIndex = Math.min(Math.floor(position), envelope.values.length - 1);
  const upperIndex = Math.min(lowerIndex + 1, envelope.values.length - 1);
  const fraction = position - lowerIndex;
  const lower = envelope.values[lowerIndex] ?? 0;
  const upper = envelope.values[upperIndex] ?? lower;
  return lower + (upper - lower) * fraction;
}

export function selectLipSyncRms(
  liveRms: number,
  envelope: RmsEnvelope | null,
  playbackTimeSeconds: number,
  liveThreshold: number,
): number {
  if (Number.isFinite(liveRms) && liveRms > liveThreshold) return liveRms;
  return envelope ? sampleRmsEnvelope(envelope, playbackTimeSeconds) : 0;
}

export class StreamingAudioCapture {
  private byteLength = 0;
  private chunks: Uint8Array[] = [];
  private enabled = true;

  constructor(
    private readonly maximumBytes = MAX_STREAMING_AUDIO_CAPTURE_BYTES,
  ) {}

  addChunk(chunk: Uint8Array): void {
    if (!this.enabled || chunk.byteLength === 0) return;
    if (this.byteLength + chunk.byteLength > this.maximumBytes) {
      this.clear();
      return;
    }
    try {
      this.chunks.push(chunk);
      this.byteLength += chunk.byteLength;
    } catch {
      this.clear();
    }
  }

  finish(): ArrayBuffer | null {
    if (!this.enabled || this.byteLength === 0) return null;
    try {
      const combined = new Uint8Array(this.byteLength);
      let offset = 0;
      for (const chunk of this.chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.clear();
      return combined.buffer;
    } catch {
      this.clear();
      return null;
    }
  }

  clear(): void {
    this.enabled = false;
    this.byteLength = 0;
    this.chunks = [];
  }
}
