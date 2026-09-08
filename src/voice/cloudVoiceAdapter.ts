import type { VoiceInputAdapter, VoiceInputAdapterOptions } from './voiceAdapter';
import { publicActive, publicFetch } from '../public/session';
import { getIosAudioSession } from '../audio/iosAudioSession';
import { resumeAudioContext } from '../audio/persistentStreamingAudio';
export function createCloudVoiceAdapter(options: VoiceInputAdapterOptions): VoiceInputAdapter {
  let context: AudioContext | null = null; let media: MediaStream | null = null; let node: AudioWorkletNode | null = null;
  let enabled = false; let playing = false; let busy = false; let manual = false; let pressed = false;
  let chunks: Int16Array[] = []; let samples = 0; let silent = 0; let segmentId = ''; let generation = 0;
  let transcription: AbortController | null = null;
  const audioSession = getIosAudioSession();
  let wanted = false;
  let opening: Promise<boolean> | null = null;
  const emit = options.onEvent;
  const reset = () => { chunks = []; samples = 0; silent = 0; segmentId = ''; };
  const flush = async () => {
    if (!samples || busy) { reset(); return; }
    const id = segmentId; const count = samples; const parts = chunks; const current = generation; reset();
    if (count < 3200 || !enabled || playing || !publicActive()) return;
    busy = true; const request = new AbortController(); transcription = request;
    emit({ type: 'speech_ended', segmentId: id, at: Date.now() });
    try {
      const buffer = new ArrayBuffer(44 + count * 2); const view = new DataView(buffer);
      const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
      ascii(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, 'data'); view.setUint32(40, count * 2, true); let offset = 44;
      for (const part of parts) for (const sample of part) { view.setInt16(offset, sample, true); offset += 2; }
      const response = await publicFetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: buffer, signal: request.signal });
      if (!response.ok) throw new Error('transcription failed');
      const result = await response.json();
      if (enabled && generation === current) emit({ type: 'utterance_finalized', segmentId: id, text: result.text, at: Date.now() });
    } catch {
      if (enabled && generation === current) {
        const stopped = stop(); const failedGeneration = generation;
        await stopped;
        if (generation === failedGeneration) emit({ type: 'recognition_failed', code: 'recognition-failed', at: Date.now() });
      }
    } finally {
      if (transcription === request) { transcription = null; busy = false; }
    }
  };
  const releaseCapture = async () => {
    ++generation; opening = null; reset(); busy = false;
    transcription?.abort(); transcription = null;
    if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
    media?.getTracks().forEach(track => track.stop()); media = null;
    const previous = context; context = null;
    try { if (previous && previous.state !== 'closed') await previous.close(); }
    catch { /* Tracks and nodes are already released even if the context cannot close. */ }
  };
  const stop = async () => {
    wanted = false; enabled = false;
    const released = releaseCapture(); const stoppedGeneration = generation;
    await released;
    if (generation === stoppedGeneration) {
      audioSession?.playback();
      emit({ type: 'recognition_stopped', at: Date.now() });
    }
  };
  const pause = () => { void stop(); };
  const control = (event: Event) => {
    const detail = (event as CustomEvent<{ manual: boolean; pressed: boolean }>).detail;
    if (manual !== detail.manual) reset(); manual = detail.manual; pressed = detail.pressed;
    if (manual && !pressed) void flush();
  };
  window.addEventListener('vayria-public-stop', pause); window.addEventListener('vayria-public-microphone', control);
  const adapter: VoiceInputAdapter = {
    isSupported: !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined', supportErrorCode: null,
    start() {
      if (!publicActive()) return Promise.resolve(false);
      wanted = true;
      if (audioSession?.playbackHeld) {
        enabled = true; emit({ type: 'listening_started', at: Date.now() });
        return Promise.resolve(true);
      }
      if (enabled && context) return Promise.resolve(true);
      if (opening) return opening;
      const current = ++generation;
      const attempt = (async () => {
      try {
        audioSession?.recording();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if (current !== generation || !wanted || !publicActive() || document.hidden || audioSession?.playbackHeld) { stream.getTracks().forEach(track => track.stop()); return false; }
        media = stream; context = new AudioContext(); await context.audioWorklet.addModule(new URL('./pcmCaptureWorklet.js', import.meta.url));
        if (current !== generation) return false;
        if (!publicActive()) { await stop(); return false; }
        node = new AudioWorkletNode(context, 'vayria-pcm-capture', { processorOptions: { inputSampleRate: context.sampleRate, targetSampleRate: 16000, chunkSamples: 320 } });
        context.createMediaStreamSource(media).connect(node); node.connect(context.destination);
        if (!(await resumeAudioContext(context))) throw new Error('Capture context did not start');
        if (current !== generation) return false;
        if (!publicActive()) { await stop(); return false; }
        enabled = true;
        node.port.onmessage = event => {
          if (!enabled || busy || playing || !publicActive() || document.hidden) { reset(); return; }
          const pcm = new Int16Array(event.data); const rms = Math.sqrt(pcm.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / pcm.length);
          const speaking = manual ? pressed : rms >= .015;
          if (!speaking && !samples) return;
          if (!segmentId) { segmentId = crypto.randomUUID(); emit({ type: 'speech_started', segmentId, at: Date.now() }); }
          chunks.push(pcm); samples += pcm.length; silent = speaking ? 0 : silent + pcm.length;
          if (samples >= 320000 || (!manual && silent >= 9600)) void flush();
        };
        emit({ type: 'listening_started', at: Date.now() }); return true;
      } catch {
        if (generation !== current) return false;
        const stopped = stop(); const failedGeneration = generation;
        await stopped;
        if (generation === failedGeneration) emit({ type: 'recognition_failed', code: 'audio-capture', at: Date.now() });
        return false;
      }
      })().finally(() => { if (opening === attempt) opening = null; });
      opening = attempt;
      return attempt;
    }, stop, setTtsPlaying(value) { playing = value; if (value) reset(); },
    dispose() { window.removeEventListener('vayria-public-stop', pause); window.removeEventListener('vayria-public-microphone', control); void stop(); unregister?.(); },
  };
  const unregister = audioSession?.register({
    pause: releaseCapture,
    resume: () => wanted && publicActive() && !document.hidden ? adapter.start() : Promise.resolve(false),
  });
  return adapter;
}
