import { useEffect, useRef, useState } from 'react';
import {
  createMediaSourceStreamTarget,
  pumpMediaSourceAudio,
} from './audio/mediaSourceStream.js';
import { PersistentStreamingAudio } from './audio/persistentStreamingAudio.js';
import {
  calculatePlaybackDiagnosticDurations,
  ConsecutiveRmsTracker,
  summarizePlaybackDiagnostics,
  TTS_PLAYBACK_DIAGNOSTIC_SAMPLE_COUNT,
  TTS_PLAYBACK_DIAGNOSTIC_STRATEGIES,
  type TtsPlaybackDiagnosticFailureKind,
  type TtsPlaybackDiagnosticSample,
  type TtsPlaybackDiagnosticStrategy,
  type TtsPlaybackDiagnosticTimestamps,
  type RmsDiagnosticResult,
} from './audio/ttsPlaybackDiagnostics.js';
import { TTS_BENCHMARK_FIXTURES } from './audio/ttsBenchmark.js';
import { apiUrl } from './runtimeConfig.js';

const SAMPLE_TIMEOUT_MS = 60_000;

interface DiagnosticReport {
  completedAt: string;
  sampleCount: number;
  samples: TtsPlaybackDiagnosticSample[];
  schemaVersion: 1;
  summaries: ReturnType<typeof summarizePlaybackDiagnostics>;
}

interface DiagnosticResources {
  carrier: PersistentStreamingAudio;
  context: AudioContext;
  gain: GainNode;
}

interface WindowWithManagedMediaSource {
  ManagedMediaSource?: typeof MediaSource;
  MediaSource?: typeof MediaSource;
}

class DiagnosticError extends Error {
  constructor(
    readonly kind: TtsPlaybackDiagnosticFailureKind,
    readonly status?: number,
  ) {
    super(kind);
  }
}

function createTimestamps(): TtsPlaybackDiagnosticTimestamps {
  return {
    current_time_advanced_at: null,
    decode_complete_at: null,
    ended_at: null,
    first_chunk_at: null,
    first_nonzero_rms_at: null,
    play_called_at: null,
    playing_at: null,
    request_at: performance.now(),
    response_complete_at: null,
    response_headers_at: null,
  };
}

function toEpochMilliseconds(value: number): number {
  return Math.round(performance.timeOrigin + value);
}

function serializeTimestamps(
  timestamps: TtsPlaybackDiagnosticTimestamps,
): TtsPlaybackDiagnosticTimestamps {
  return Object.fromEntries(
    Object.entries(timestamps).map(([key, value]) => [
      key,
      value === null ? null : toEpochMilliseconds(value),
    ]),
  ) as unknown as TtsPlaybackDiagnosticTimestamps;
}

function classifyError(error: unknown): {
  kind: TtsPlaybackDiagnosticFailureKind;
  status?: number;
} {
  if (error instanceof DiagnosticError) {
    return {
      kind: error.kind,
      ...(error.status ? { status: error.status } : {}),
    };
  }
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return { kind: 'aborted' };
    if (error.name === 'NotAllowedError') return { kind: 'not_allowed' };
  }
  return { kind: 'media_error' };
}

function readMediaSourceConstructor(): typeof MediaSource | null {
  const mediaWindow = window as unknown as WindowWithManagedMediaSource;
  return mediaWindow.ManagedMediaSource ?? mediaWindow.MediaSource ?? null;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function waitForEvent(
  target: EventTarget,
  successType: string,
  errorType: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(successType, handleSuccess);
      target.removeEventListener(errorType, handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new DiagnosticError('media_error'));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Aborted.', 'AbortError'));
    };
    target.addEventListener(successType, handleSuccess, { once: true });
    target.addEventListener(errorType, handleError, { once: true });
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const handleParentAbort = () => controller.abort();
  parentSignal.addEventListener('abort', handleParentAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SAMPLE_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new DiagnosticError('timeout');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener('abort', handleParentAbort);
  }
}

async function collectResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (timestamps.first_chunk_at === null) {
      timestamps.first_chunk_at = performance.now();
    }
    const copy = value.slice();
    chunks.push(copy);
    byteLength += copy.byteLength;
  }
  timestamps.response_complete_at = performance.now();
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function startRmsMeasurement(
  analyser: AnalyserNode,
  readPlaybackTime: () => number,
  initialPlaybackTime: number,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): { finish: () => ReturnType<ConsecutiveRmsTracker['result']> } {
  const tracker = new ConsecutiveRmsTracker();
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const update = () => {
    const now = performance.now();
    const playbackTime = readPlaybackTime();
    if (
      timestamps.current_time_advanced_at === null &&
      playbackTime > initialPlaybackTime + 0.001
    ) {
      timestamps.current_time_advanced_at = now;
    }
    analyser.getFloatTimeDomainData(samples);
    tracker.sample(samples, now);
    const result = tracker.result();
    if (
      timestamps.first_nonzero_rms_at === null &&
      result.firstNonzeroAt !== null
    ) {
      timestamps.first_nonzero_rms_at = result.firstNonzeroAt;
    }
    frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);
  return {
    finish: () => {
      cancelAnimationFrame(frame);
      return tracker.result();
    },
  };
}

async function measureMediaElement(
  audio: HTMLAudioElement,
  analyser: AnalyserNode,
  signal: AbortSignal,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<ReturnType<ConsecutiveRmsTracker['result']>> {
  const playing = waitForEvent(audio, 'playing', 'error', signal);
  const ended = waitForEvent(audio, 'ended', 'error', signal);
  timestamps.play_called_at = performance.now();
  const playAttempt = audio.play();
  void playAttempt.catch(() => undefined);
  await Promise.race([playing, playAttempt]);
  await playing;
  timestamps.playing_at = performance.now();
  const initialTime = audio.currentTime;
  const measurement = startRmsMeasurement(
    analyser,
    () => audio.currentTime,
    initialTime,
    timestamps,
  );
  try {
    await ended;
    timestamps.ended_at = performance.now();
    return measurement.finish();
  } catch (error) {
    measurement.finish();
    throw error;
  }
}

async function readTtsResponse(
  text: string,
  signal: AbortSignal,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<{
  backend: string;
  mediaType: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const response = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, emotion: 'neutral' }),
    signal,
  });
  timestamps.response_headers_at = performance.now();
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new DiagnosticError('http_error', response.status);
  }
  const mediaType =
    response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ??
    'application/octet-stream';
  if (mediaType !== 'audio/mpeg') {
    void response.body?.cancel().catch(() => undefined);
    throw new DiagnosticError('unsupported_media_type');
  }
  if (!response.body) throw new DiagnosticError('media_error');
  return {
    backend: response.headers.get('X-Vayria-Tts-Backend') || 'unknown',
    mediaType,
    reader: response.body.getReader(),
  };
}

function connectMediaElement(
  resources: DiagnosticResources,
): { analyser: AnalyserNode; audio: HTMLAudioElement } {
  resources.carrier.disconnect();
  const { audio, source } = resources.carrier.ensure(resources.context);
  const analyser = resources.context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  analyser.connect(resources.gain);
  return { analyser, audio };
}

async function runMediaSourceSample(
  resources: DiagnosticResources,
  text: string,
  signal: AbortSignal,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<{
  backend: string;
  mediaType: string;
  rms: ReturnType<ConsecutiveRmsTracker['result']>;
}> {
  const response = await readTtsResponse(text, signal, timestamps);
  const MediaSourceConstructor = readMediaSourceConstructor();
  if (!MediaSourceConstructor?.isTypeSupported(response.mediaType)) {
    throw new DiagnosticError('unsupported_media_type');
  }
  const { analyser, audio } = connectMediaElement(resources);
  const mediaSource = new MediaSourceConstructor();
  const url = URL.createObjectURL(mediaSource);
  resources.carrier.setSource(url);
  audio.load();
  try {
    await waitForEvent(mediaSource, 'sourceopen', 'error', signal);
    const sourceBuffer = mediaSource.addSourceBuffer(response.mediaType);
    let resolveFirstChunk: () => void = () => undefined;
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve;
    });
    const pump = pumpMediaSourceAudio(
      response.reader,
      createMediaSourceStreamTarget(mediaSource, sourceBuffer),
      {
        onFirstChunk: () => {
          timestamps.first_chunk_at = performance.now();
          resolveFirstChunk();
        },
        onComplete: () => {
          timestamps.response_complete_at = performance.now();
        },
      },
    );
    void pump.catch(() => undefined);
    await firstChunk;
    const [rms] = await Promise.all([
      measureMediaElement(audio, analyser, signal, timestamps),
      pump,
    ]);
    return { backend: response.backend, mediaType: response.mediaType, rms };
  } finally {
    void response.reader.cancel().catch(() => undefined);
    resources.carrier.clearSource();
    resources.carrier.disconnect();
    analyser.disconnect();
    URL.revokeObjectURL(url);
  }
}

async function runMediaElementBlobSample(
  resources: DiagnosticResources,
  text: string,
  signal: AbortSignal,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<{
  backend: string;
  mediaType: string;
  rms: ReturnType<ConsecutiveRmsTracker['result']>;
}> {
  const response = await readTtsResponse(text, signal, timestamps);
  let bytes: Uint8Array;
  try {
    bytes = await collectResponse(response.reader, timestamps);
  } finally {
    void response.reader.cancel().catch(() => undefined);
  }
  const { analyser, audio } = connectMediaElement(resources);
  const url = URL.createObjectURL(
    new Blob([copyToArrayBuffer(bytes)], { type: response.mediaType }),
  );
  resources.carrier.setSource(url);
  audio.load();
  try {
    const rms = await measureMediaElement(audio, analyser, signal, timestamps);
    return { backend: response.backend, mediaType: response.mediaType, rms };
  } finally {
    resources.carrier.clearSource();
    resources.carrier.disconnect();
    analyser.disconnect();
    URL.revokeObjectURL(url);
  }
}

async function runAudioBufferSample(
  resources: DiagnosticResources,
  text: string,
  signal: AbortSignal,
  timestamps: TtsPlaybackDiagnosticTimestamps,
): Promise<{
  backend: string;
  mediaType: string;
  rms: ReturnType<ConsecutiveRmsTracker['result']>;
}> {
  const response = await readTtsResponse(text, signal, timestamps);
  let bytes: Uint8Array;
  try {
    bytes = await collectResponse(response.reader, timestamps);
  } finally {
    void response.reader.cancel().catch(() => undefined);
  }
  let decoded: AudioBuffer;
  try {
    decoded = await resources.context.decodeAudioData(copyToArrayBuffer(bytes));
    timestamps.decode_complete_at = performance.now();
  } catch {
    throw new DiagnosticError('decode_error');
  }
  const source = resources.context.createBufferSource();
  const analyser = resources.context.createAnalyser();
  analyser.fftSize = 2048;
  source.buffer = decoded;
  source.connect(analyser);
  analyser.connect(resources.gain);
  const ended = new Promise<void>((resolve) => {
    source.onended = () => resolve();
  });
  const startContextTime = resources.context.currentTime;
  timestamps.play_called_at = performance.now();
  source.start();
  timestamps.playing_at = performance.now();
  const measurement = startRmsMeasurement(
    analyser,
    () => resources.context.currentTime,
    startContextTime,
    timestamps,
  );
  try {
    await Promise.race([
      ended,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted.', 'AbortError')),
          { once: true },
        );
      }),
    ]);
    timestamps.ended_at = performance.now();
    return {
      backend: response.backend,
      mediaType: response.mediaType,
      rms: measurement.finish(),
    };
  } finally {
    try {
      source.stop();
    } catch {
      // The source already ended.
    }
    measurement.finish();
    source.disconnect();
    analyser.disconnect();
  }
}

function emptyRms(): RmsDiagnosticResult {
  return {
    activeFrames: 0,
    firstNonzeroAt: null,
    max: 0,
    totalFrames: 0,
  };
}

function formatMetric(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

export function TtsPlaybackDiagnosticsPanel() {
  const resourcesRef = useRef<DiagnosticResources | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState('Ready');
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [running, setRunning] = useState(false);

  const ensureResources = (): DiagnosticResources => {
    const existing = resourcesRef.current;
    if (existing && existing.context.state !== 'closed') return existing;
    const context = new AudioContext();
    const gain = context.createGain();
    gain.connect(context.destination);
    const resources = {
      carrier: new PersistentStreamingAudio(),
      context,
      gain,
    };
    resources.carrier.ensure(context);
    resourcesRef.current = resources;
    return resources;
  };

  const runSample = async (
    resources: DiagnosticResources,
    strategy: TtsPlaybackDiagnosticStrategy,
    fixture: (typeof TTS_BENCHMARK_FIXTURES)[number],
    iteration: number,
    signal: AbortSignal,
  ): Promise<TtsPlaybackDiagnosticSample> => {
    const timestamps = createTimestamps();
    let backend = 'unknown';
    let mediaType = 'unknown';
    let rms = emptyRms();
    let failure: TtsPlaybackDiagnosticSample['failure'];
    try {
      const result = await withTimeout(
        (sampleSignal) =>
          strategy === 'media-source'
            ? runMediaSourceSample(
                resources,
                fixture.text,
                sampleSignal,
                timestamps,
              )
            : strategy === 'media-element-blob'
              ? runMediaElementBlobSample(
                  resources,
                  fixture.text,
                  sampleSignal,
                  timestamps,
                )
              : runAudioBufferSample(
                  resources,
                  fixture.text,
                  sampleSignal,
                  timestamps,
                ),
        signal,
      );
      backend = result.backend;
      mediaType = result.mediaType;
      rms = result.rms;
    } catch (error) {
      failure = classifyError(error);
    }
    const durationsMs = calculatePlaybackDiagnosticDurations(timestamps);
    return {
      backend,
      durationsMs,
      ...(failure ? { failure } : {}),
      fixtureId: fixture.id,
      iteration,
      mediaType,
      rms: {
        activeFrames: rms.activeFrames,
        firstNonzeroDetected: rms.firstNonzeroAt !== null,
        max: Number(rms.max.toFixed(6)),
        totalFrames: rms.totalFrames,
      },
      strategy,
      textLength: fixture.text.length,
      timestamps: serializeTimestamps(timestamps),
    };
  };

  const start = async () => {
    if (running) return;
    setRunning(true);
    setReport(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const samples: TtsPlaybackDiagnosticSample[] = [];
    try {
      const resources = ensureResources();
      const preparation = resources.carrier.prepare(resources.context, false);
      if (!(await preparation)) throw new DiagnosticError('not_allowed');
      for (const strategy of TTS_PLAYBACK_DIAGNOSTIC_STRATEGIES) {
        for (const fixture of TTS_BENCHMARK_FIXTURES) {
          if (controller.signal.aborted) break;
          setProgress(`${strategy} / ${fixture.id}: warm-up`);
          await runSample(
            resources,
            strategy,
            fixture,
            0,
            controller.signal,
          );
          for (
            let iteration = 1;
            iteration <= TTS_PLAYBACK_DIAGNOSTIC_SAMPLE_COUNT;
            iteration += 1
          ) {
            if (controller.signal.aborted) break;
            setProgress(
              `${strategy} / ${fixture.id}: ${iteration}/${TTS_PLAYBACK_DIAGNOSTIC_SAMPLE_COUNT}`,
            );
            samples.push(
              await runSample(
                resources,
                strategy,
                fixture,
                iteration,
                controller.signal,
              ),
            );
          }
        }
      }
      setProgress(controller.signal.aborted ? 'Stopped' : 'Complete');
    } catch (error) {
      setProgress(classifyError(error).kind === 'aborted' ? 'Stopped' : 'Failed');
    } finally {
      abortRef.current = null;
      setRunning(false);
      setReport({
        completedAt: new Date().toISOString(),
        sampleCount: samples.length,
        samples,
        schemaVersion: 1,
        summaries: summarizePlaybackDiagnostics(samples),
      });
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    resourcesRef.current?.carrier.clearSource();
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      const resources = resourcesRef.current;
      resources?.carrier.dispose();
      resources?.gain.disconnect();
      if (resources?.context.state !== 'closed') {
        void resources?.context.close();
      }
      resourcesRef.current = null;
    },
    [],
  );

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vayria-tts-playback-diagnostics-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="diagnostic-panel" aria-labelledby="diagnostic-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">iPad Safari investigation</p>
          <h2 id="diagnostic-heading">Lip sync playback paths</h2>
          <p className="section-copy">
            Compare streaming MediaSource, buffered media element, and AudioBuffer analysis.
          </p>
        </div>
        <div className="actions">
          <button className="primary" disabled={running} onClick={() => void start()}>
            Start diagnostics
          </button>
          <button disabled={!running} onClick={stop}>Stop</button>
        </div>
      </div>
      <dl className="diagnostic-status">
        <div><dt>Status</dt><dd aria-live="polite">{progress}</dd></div>
        <div><dt>Measured samples</dt><dd>{report?.sampleCount ?? 0}</dd></div>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Path</th><th>Fixture</th><th>RMS found</th>
              <th>First RMS median / max</th>
            </tr>
          </thead>
          <tbody>
            {(report?.summaries ?? []).map((summary) => (
              <tr key={`${summary.strategy}-${summary.fixtureId}`}>
                <th>{summary.strategy}</th>
                <td>{summary.fixtureId}</td>
                <td>{summary.firstRmsCount} / {summary.sampleCount}</td>
                <td>
                  {formatMetric(summary.firstRmsDelayMs.median)} /{' '}
                  {formatMetric(summary.firstRmsDelayMs.max)}
                </td>
              </tr>
            ))}
            {!report && (
              <tr><td colSpan={4} className="empty">No diagnostic run yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {report && (
        <details className="diagnostic-details">
          <summary>Individual results ({report.sampleCount})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Path</th><th>Fixture / run</th><th>First chunk</th>
                  <th>Download</th><th>Play → playing</th>
                  <th>Playing → clock</th><th>Playing → RMS</th>
                  <th>Max RMS / failure</th>
                </tr>
              </thead>
              <tbody>
                {report.samples.map((sample) => (
                  <tr
                    key={`${sample.strategy}-${sample.fixtureId}-${sample.iteration}`}
                  >
                    <th>{sample.strategy}</th>
                    <td>{sample.fixtureId} / {sample.iteration}</td>
                    <td>{formatMetric(sample.durationsMs.firstChunk)}</td>
                    <td>{formatMetric(sample.durationsMs.download)}</td>
                    <td>{formatMetric(sample.durationsMs.playToPlaying)}</td>
                    <td>{formatMetric(sample.durationsMs.playingToCurrentTime)}</td>
                    <td>{formatMetric(sample.durationsMs.playingToFirstRms)}</td>
                    <td>
                      {sample.failure?.kind ?? sample.rms.max.toFixed(6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="diagnostic-footer">
        <p>
          Browser timing only. Speaker output time is not measured. Raw text and secrets are not exported.
        </p>
        <button disabled={!report} onClick={download}>Download diagnostic JSON</button>
      </div>
    </section>
  );
}
