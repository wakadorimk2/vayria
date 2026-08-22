const TARGET_SAMPLE_RATE = 16_000;
const DEFAULT_CHUNK_SAMPLES = 3_200;

function downmixToMono(channels) {
  const frameCount = channels[0]?.length ?? 0;
  const mono = new Float32Array(frameCount);
  if (channels.length === 0) return mono;

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame] ?? 0;
    mono[frame] = sum / channels.length;
  }
  return mono;
}

function encodePcm16(samples) {
  const bytes = new ArrayBuffer(samples.length * 2);
  const view = new DataView(bytes);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const value = sample < 0 ? sample * 32_768 : sample * 32_767;
    view.setInt16(index * 2, Math.round(value), true);
  }
  return bytes;
}

class StreamingPcm16Encoder {
  constructor(inputSampleRate, targetSampleRate = TARGET_SAMPLE_RATE, chunkSamples = DEFAULT_CHUNK_SAMPLES) {
    this.sourceBuffer = [];
    this.outputBuffer = [];
    this.sourceCursor = 0;
    this.sourceStep = inputSampleRate / targetSampleRate;
    this.chunkSamples = chunkSamples;
  }

  push(channels) {
    const mono = downmixToMono(channels);
    for (const sample of mono) this.sourceBuffer.push(sample);

    const resampled = [];
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

    const chunks = [];
    while (this.outputBuffer.length >= this.chunkSamples) {
      chunks.push(encodePcm16(this.outputBuffer.splice(0, this.chunkSamples)));
    }
    return chunks;
  }
}

class VayriaPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions ?? {};
    this.encoder = new StreamingPcm16Encoder(
      processorOptions.inputSampleRate ?? 48_000,
      processorOptions.targetSampleRate,
      processorOptions.chunkSamples,
    );
  }

  process(inputs, outputs) {
    const chunks = this.encoder.push(inputs[0] ?? []);
    for (const chunk of chunks) this.port.postMessage(chunk, [chunk]);
    for (const output of outputs[0] ?? []) output.fill(0);
    return true;
  }
}

registerProcessor('vayria-pcm-capture', VayriaPcmCaptureProcessor);
