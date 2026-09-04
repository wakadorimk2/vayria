import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readAudioPlaybackSource } from './audio/audioPlaybackSource.js';
import { useAudioLipSync } from './audio/useAudioLipSync.js';
import {
  summarizeTtsBenchmark,
  TTS_BENCHMARK_FIXTURES,
  TTS_BENCHMARK_SAMPLE_COUNT,
  readTtsFallback,
  type TtsBenchmarkSample,
} from './audio/ttsBenchmark.js';
import { apiUrl, runtimeConfig } from './runtimeConfig.js';
import { TtsPlaybackDiagnosticsPanel } from './TtsPlaybackDiagnosticsPanel.js';
import './ttsBenchmark.css';

interface BenchmarkReport {
  backend: string;
  completedAt: string;
  fallbackCount?: number;
  failure?: { kind: string; status?: number };
  sampleCount: number;
  samples: TtsBenchmarkSample[];
  schemaVersion: 1;
  summaries: ReturnType<typeof summarizeTtsBenchmark>;
}

function toEpochMilliseconds(value: number): number {
  return Math.round(performance.timeOrigin + value);
}

export function BenchmarkApp() {
  const { play, prepare, stop } = useAudioLipSync();
  const abortRef = useRef<AbortController | null>(null);
  const [backend, setBackend] = useState('not measured');
  const [progress, setProgress] = useState('Ready');
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [running, setRunning] = useState(false);

  const runSample = async (
    fixture: (typeof TTS_BENCHMARK_FIXTURES)[number],
    iteration: number,
    signal: AbortSignal,
  ): Promise<TtsBenchmarkSample> => {
    const textReadyAt = performance.now();
    const ttsRequestAt = performance.now();
    const response = await fetch(apiUrl('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: fixture.text, emotion: 'neutral' }),
      signal,
    });
    const selectedBackend =
      response.headers.get('X-Vayria-Tts-Backend') || 'unknown';
    const fallback = readTtsFallback(response.headers);
    setBackend(
      fallback
        ? `${selectedBackend} (fallback: ${fallback.reason})`
        : selectedBackend,
    );
    if (!response.ok) {
      const error = new Error(`TTS request returned HTTP ${response.status}.`);
      Object.assign(error, { status: response.status });
      throw error;
    }

    const source = await readAudioPlaybackSource(response, {
      streamMpegPlayback: runtimeConfig.cloudTtsStreamPlaybackEnabled,
    });
    let firstAudioAt = source.kind === 'buffer' ? performance.now() : 0;
    let ttsCompletedAt = source.kind === 'buffer' ? firstAudioAt : 0;
    let playbackStartedAt = 0;
    await play(source, {
      onFirstAudioReady: (at) => {
        firstAudioAt = at;
      },
      onComplete: (at) => {
        ttsCompletedAt = at;
      },
      onStart: (at) => {
        playbackStartedAt = at;
      },
    });
    if (!firstAudioAt || !ttsCompletedAt || !playbackStartedAt) {
      throw new Error('TTS playback did not produce complete timing data.');
    }

    return {
      backend: selectedBackend,
      ...(fallback ? { fallback } : {}),
      fixtureId: fixture.id,
      iteration,
      textLength: fixture.text.length,
      timestamps: {
        text_ready_at: toEpochMilliseconds(textReadyAt),
        tts_request_at: toEpochMilliseconds(ttsRequestAt),
        first_audio_at: toEpochMilliseconds(firstAudioAt),
        playback_started_at: toEpochMilliseconds(playbackStartedAt),
        tts_completed_at: toEpochMilliseconds(ttsCompletedAt),
      },
      durationsMs: {
        firstAudio: Math.round(firstAudioAt - ttsRequestAt),
        synthesis: Math.round(ttsCompletedAt - ttsRequestAt),
        ttfa: Math.round(playbackStartedAt - textReadyAt),
      },
    };
  };

  const start = async () => {
    if (running) return;
    setRunning(true);
    setReport(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const samples: TtsBenchmarkSample[] = [];
    let selectedBackend = 'unknown';
    let failure: BenchmarkReport['failure'];

    try {
      if (!(await prepare())) throw new Error('Audio playback is unavailable.');
      for (const fixture of TTS_BENCHMARK_FIXTURES) {
        setProgress(`${fixture.id}: warm-up`);
        const warmUp = await runSample(fixture, 0, controller.signal);
        selectedBackend = warmUp.backend;
        for (let iteration = 1; iteration <= TTS_BENCHMARK_SAMPLE_COUNT; iteration += 1) {
          setProgress(`${fixture.id}: ${iteration}/${TTS_BENCHMARK_SAMPLE_COUNT}`);
          const sample = await runSample(fixture, iteration, controller.signal);
          selectedBackend = sample.backend;
          samples.push(sample);
        }
      }
      setProgress('Complete');
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      failure = {
        kind:
          error instanceof DOMException && error.name === 'AbortError'
            ? 'aborted'
            : status
              ? 'http_error'
              : 'playback_error',
        ...(status ? { status } : {}),
      };
      setProgress(failure.kind === 'aborted' ? 'Stopped' : 'Failed');
    } finally {
      abortRef.current = null;
      setRunning(false);
      setReport({
        schemaVersion: 1,
        backend: selectedBackend,
        completedAt: new Date().toISOString(),
        fallbackCount: samples.filter((sample) => sample.fallback).length,
        sampleCount: samples.length,
        samples,
        summaries: summarizeTtsBenchmark(samples),
        ...(failure ? { failure } : {}),
      });
    }
  };

  const stopBenchmark = () => {
    abortRef.current?.abort();
    stop();
  };

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vayria-tts-${report.backend}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main>
      <header>
        <p className="eyebrow">Vayria development tool</p>
        <h1>TTS playback diagnostics</h1>
        <p className="lede">
          Measure lip sync playback paths first. The existing TTFA benchmark remains available below.
        </p>
      </header>

      <TtsPlaybackDiagnosticsPanel />

      <section className="run-panel ttfa-run-panel" aria-labelledby="run-heading">
        <div>
          <p className="section-kicker">Existing measurement</p>
          <h2 id="run-heading">TTFA benchmark</h2>
          <dl>
            <div><dt>Backend</dt><dd>{backend}</dd></div>
            <div><dt>Status</dt><dd aria-live="polite">{progress}</dd></div>
          </dl>
        </div>
        <div className="actions">
          <button disabled={running} onClick={() => void start()}>
            Start benchmark
          </button>
          <button disabled={!running} onClick={stopBenchmark}>Stop</button>
        </div>
      </section>

      <section aria-labelledby="results-heading">
        <div className="section-heading">
          <h2 id="results-heading">Measured results</h2>
          <button disabled={!report} onClick={download}>Download JSON</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fixture</th><th>Samples</th><th>Fallbacks</th><th>TTFA p50 / p95</th><th>First audio p50 / p95</th><th>Synthesis p50 / p95</th></tr></thead>
            <tbody>
              {(report?.summaries ?? []).map((summary) => (
                <tr key={summary.fixtureId}>
                  <th>{summary.fixtureId}</th>
                  <td>{summary.sampleCount}</td>
                  <td>
                    {summary.fallbackCount === 0
                      ? '0'
                      : `${summary.fallbackCount} (${[
                          ...new Set(
                            report!.samples
                              .filter(
                                (sample) =>
                                  sample.fixtureId === summary.fixtureId,
                              )
                              .flatMap((sample) =>
                                sample.fallback ? [sample.fallback.reason] : [],
                              ),
                          ),
                        ].join(', ')})`}
                  </td>
                  <td>{summary.ttfaMs.p50} / {summary.ttfaMs.p95} ms</td>
                  <td>{summary.firstAudioMs.p50} / {summary.firstAudioMs.p95} ms</td>
                  <td>{summary.synthesisMs.p50} / {summary.synthesisMs.p95} ms</td>
                </tr>
              ))}
              {!report && <tr><td colSpan={6} className="empty">No measured run yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {report?.failure && (
          <p className="error" role="alert">
            Run stopped: {report.failure.kind}{report.failure.status ? ` (HTTP ${report.failure.status})` : ''}
          </p>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<BenchmarkApp />);
