export const PCM_TARGET_SAMPLE_RATE = 16_000;
export const PCM_CHANNEL_COUNT = 1;
export const PCM_CHUNK_DURATION_MS = 200;
export const PCM_CHUNK_SAMPLES =
  (PCM_TARGET_SAMPLE_RATE * PCM_CHUNK_DURATION_MS) / 1_000;
export const PCM_CHUNK_BYTES = PCM_CHUNK_SAMPLES * 2;

export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const frameCount = channels[0]?.length ?? 0;
  const mono = new Float32Array(frameCount);
  if (channels.length === 0) return mono;

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[frame] ?? 0;
    }
    mono[frame] = sum / channels.length;
  }

  return mono;
}

export function encodePcm16(samples: readonly number[]): ArrayBuffer {
  const bytes = new ArrayBuffer(samples.length * 2);
  const view = new DataView(bytes);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const value = sample < 0 ? sample * 32_768 : sample * 32_767;
    view.setInt16(index * 2, Math.round(value), true);
  }
  return bytes;
}

export class StreamingPcm16Encoder {
  private readonly sourceBuffer: number[] = [];
  private readonly outputBuffer: number[] = [];
  private sourceCursor = 0;
  private readonly sourceStep: number;

  constructor(
    private readonly inputSampleRate: number,
    private readonly targetSampleRate = PCM_TARGET_SAMPLE_RATE,
    private readonly chunkSamples = PCM_CHUNK_SAMPLES,
  ) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new Error('inputSampleRate must be a positive finite number.');
    }
    if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
      throw new Error('targetSampleRate must be a positive finite number.');
    }
    if (!Number.isInteger(chunkSamples) || chunkSamples <= 0) {
      throw new Error('chunkSamples must be a positive integer.');
    }
    this.sourceStep = inputSampleRate / targetSampleRate;
  }

  push(channels: readonly Float32Array[]): ArrayBuffer[] {
    const mono = downmixToMono(channels);
    for (const sample of mono) this.sourceBuffer.push(sample);

    const resampled: number[] = [];
    while (this.sourceCursor + 1 < this.sourceBuffer.length) {
      const baseIndex = Math.floor(this.sourceCursor);
      const fraction = this.sourceCursor - baseIndex;
      const first = this.sourceBuffer[baseIndex] ?? 0;
      const second = this.sourceBuffer[baseIndex + 1] ?? first;
      resampled.push(first + (second - first) * fraction);
      this.sourceCursor += this.sourceStep;
    }

    const consumed = Math.floor(this.sourceCursor);
    if (consumed > 0) {
      this.sourceBuffer.splice(0, consumed);
      this.sourceCursor -= consumed;
    }
    this.outputBuffer.push(...resampled);

    const chunks: ArrayBuffer[] = [];
    while (this.outputBuffer.length >= this.chunkSamples) {
      chunks.push(encodePcm16(this.outputBuffer.splice(0, this.chunkSamples)));
    }
    return chunks;
  }
}
