import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiUrl } from './runtimeConfig.js';
import { summarizeStreamBench } from './stream/streamBench.js';
import type {
  StreamBenchFixtureSummary,
  StreamBenchProviderInfo,
  StreamBenchRunResult,
  StreamVisionProviderId,
} from './stream/streamContract.js';
import { STREAM_BENCH_PATH } from './stream/streamContract.js';
import './ttsBenchmark.css';
import './streamBenchmark.css';

interface FixtureListResponse {
  root: string;
  fixtures: StreamBenchFixtureSummary[];
}

interface ProviderListResponse {
  providers: StreamBenchProviderInfo[];
}

interface BenchReport {
  schemaVersion: 1;
  completedAt: string;
  results: StreamBenchRunResult[];
  summaries: ReturnType<typeof summarizeStreamBench>;
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${numerator}/${denominator} (${Math.round((numerator / denominator) * 100)}%)`;
}

function formatLatency(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

function formatCost(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

function ChangedBadge({ result }: { result: StreamBenchRunResult }) {
  if (result.expected?.changed === null || result.expected === undefined) {
    return <span className="badge na">n/a</span>;
  }
  if (result.observation === null) {
    return <span className="badge bad">no obs</span>;
  }
  const correct = result.observation.changed === result.expected.changed;
  return (
    <span className={correct ? 'badge ok' : 'badge bad'}>
      {result.observation.changed ? 'changed' : 'static'}
    </span>
  );
}

export function StreamBenchmarkApp() {
  const abortRef = useRef<AbortController | null>(null);
  const [providers, setProviders] = useState<StreamBenchProviderInfo[]>([]);
  const [fixtures, setFixtures] = useState<StreamBenchFixtureSummary[]>([]);
  const [fixtureRoot, setFixtureRoot] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<
    Set<StreamVisionProviderId>
  >(new Set());
  const [modelOverrides, setModelOverrides] = useState<
    Record<string, string>
  >({});
  const [selectedFixtures, setSelectedFixtures] = useState<Set<string>>(
    new Set(),
  );
  const [reps, setReps] = useState(3);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('Ready');
  const [results, setResults] = useState<StreamBenchRunResult[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [fixtureResponse, providerResponse] = await Promise.all([
          fetch(apiUrl(`${STREAM_BENCH_PATH}/fixtures`)),
          fetch(apiUrl(`${STREAM_BENCH_PATH}/providers`)),
        ]);
        if (!fixtureResponse.ok || !providerResponse.ok) {
          setLoadError(
            'VLM benchmark API is unavailable. Start the dev server with VAYRIA_STREAM_BENCH=true.',
          );
          return;
        }
        const fixtureData = (await fixtureResponse.json()) as FixtureListResponse;
        const providerData =
          (await providerResponse.json()) as ProviderListResponse;
        setFixtures(fixtureData.fixtures);
        setFixtureRoot(fixtureData.root);
        setSelectedFixtures(new Set(fixtureData.fixtures.map((f) => f.id)));
        setProviders(providerData.providers);
        setSelectedProviders(
          new Set(
            providerData.providers
              .filter((provider) => provider.configured)
              .map((provider) => provider.id),
          ),
        );
      } catch {
        setLoadError(
          'VLM benchmark API is unreachable. Start the dev server with VAYRIA_STREAM_BENCH=true.',
        );
      }
    })();
  }, []);

  const toggleFixture = (id: string) => {
    setSelectedFixtures((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleProvider = (id: StreamVisionProviderId) => {
    setSelectedProviders((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const runOne = async (
    fixtureId: string,
    providerId: StreamVisionProviderId,
    signal: AbortSignal,
  ): Promise<StreamBenchRunResult> => {
    const model = modelOverrides[providerId]?.trim();
    const response = await fetch(apiUrl(STREAM_BENCH_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fixtureId,
        providerId,
        ...(model ? { model } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return {
        fixtureId,
        providerId,
        model: model ?? providers.find((p) => p.id === providerId)?.model ?? '',
        ok: false,
        jsonOk: false,
        parseOk: false,
        latencyMs: 0,
        observation: null,
        error: {
          kind: 'http',
          message: body?.error ?? `HTTP ${response.status}`,
          status: response.status,
        },
      };
    }
    return (await response.json()) as StreamBenchRunResult;
  };

  const start = async () => {
    if (running) return;
    setRunning(true);
    setResults([]);
    const controller = new AbortController();
    abortRef.current = controller;
    const providerList = providers.filter((provider) =>
      selectedProviders.has(provider.id),
    );
    const fixtureList = fixtures.filter((fixture) =>
      selectedFixtures.has(fixture.id),
    );
    try {
      for (const provider of providerList) {
        for (let rep = 1; rep <= reps; rep += 1) {
          for (const fixture of fixtureList) {
            setProgress(
              `${provider.id} rep ${rep}/${reps} — ${fixture.id}`,
            );
            const result = await runOne(
              fixture.id,
              provider.id,
              controller.signal,
            );
            setResults((current) => [...current, result]);
          }
        }
      }
      setProgress('Complete');
    } catch (error) {
      setProgress(
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Stopped'
          : 'Failed',
      );
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const summaries = summarizeStreamBench(results, providers);
  const totalRequests =
    selectedProviders.size * selectedFixtures.size * Math.max(1, reps);
  const failureCount = results.filter((result) => result.error).length;

  const download = () => {
    const report: BenchReport = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      results,
      summaries,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vayria-stream-vlm-bench-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main>
      <header>
        <p className="eyebrow">Vayria development tool</p>
        <h1>Stream VLM benchmark</h1>
        <p className="lede">
          Compare vision providers on before/after 7 Days to Die frame pairs.
          Fixture root: <code>{fixtureRoot || 'stream-bench/fixtures'}</code>
        </p>
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
      </header>

      <section aria-labelledby="providers-heading">
        <p className="section-kicker">Providers</p>
        <h2 id="providers-heading">Select models to compare</h2>
        <div className="provider-list">
          {providers.map((provider) => (
            <label key={provider.id} className="provider-option">
              <input
                type="checkbox"
                checked={selectedProviders.has(provider.id)}
                disabled={!provider.configured || running}
                onChange={() => toggleProvider(provider.id)}
              />
              <span>
                <span className="provider-label">{provider.label}</span>{' '}
                <span className="provider-model">
                  {modelOverrides[provider.id]?.trim() || provider.model}
                </span>
                {!provider.configured && (
                  <span className="provider-off"> (no API key)</span>
                )}
              </span>
              <input
                className="model-override"
                type="text"
                placeholder="model override"
                disabled={running}
                value={modelOverrides[provider.id] ?? ''}
                onChange={(event) =>
                  setModelOverrides((current) => ({
                    ...current,
                    [provider.id]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
          {providers.length === 0 && !loadError && (
            <p className="bench-note">Loading providers…</p>
          )}
        </div>
      </section>

      <section aria-labelledby="fixtures-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Fixtures</p>
            <h2 id="fixtures-heading">
              Before/after frame pairs ({selectedFixtures.size}/{fixtures.length} selected)
            </h2>
          </div>
          <div className="actions">
            <button
              disabled={running}
              onClick={() =>
                setSelectedFixtures(new Set(fixtures.map((f) => f.id)))
              }
            >
              All
            </button>
            <button
              disabled={running}
              onClick={() => setSelectedFixtures(new Set())}
            >
              None
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Fixture</th>
                <th>Frames</th>
                <th>Category</th>
                <th>Expected</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map((fixture) => (
                <tr key={fixture.id}>
                  <td className="fixture-check">
                    <input
                      type="checkbox"
                      checked={selectedFixtures.has(fixture.id)}
                      disabled={running}
                      onChange={() => toggleFixture(fixture.id)}
                      aria-label={`Select ${fixture.id}`}
                    />
                  </td>
                  <th>{fixture.id}</th>
                  <td>
                    <div className="fixture-thumb">
                      <figure>
                        <img
                          src={apiUrl(
                            `${STREAM_BENCH_PATH}/fixture-image?id=${encodeURIComponent(fixture.id)}&which=before`,
                          )}
                          alt={`${fixture.id} before`}
                          loading="lazy"
                        />
                        <figcaption>before</figcaption>
                      </figure>
                      <figure>
                        <img
                          src={apiUrl(
                            `${STREAM_BENCH_PATH}/fixture-image?id=${encodeURIComponent(fixture.id)}&which=after`,
                          )}
                          alt={`${fixture.id} after`}
                          loading="lazy"
                        />
                        <figcaption>after</figcaption>
                      </figure>
                    </div>
                  </td>
                  <td>{fixture.category}</td>
                  <td>
                    {fixture.expectedChanged === null
                      ? '—'
                      : `${fixture.expectedChanged ? 'changed' : 'static'}${
                          fixture.expectedEventKinds.length
                            ? ` + ${fixture.expectedEventKinds.join(', ')}`
                            : ''
                        }`}
                  </td>
                </tr>
              ))}
              {fixtures.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No fixtures. Add before/after frame pairs under{' '}
                    <code>stream-bench/fixtures/&lt;id&gt;/</code>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="run-panel" aria-labelledby="run-heading">
        <div>
          <p className="section-kicker">Sweep</p>
          <h2 id="run-heading">Run benchmark</h2>
          <div className="run-controls">
            <label className="reps-field">
              Repetitions per fixture
              <input
                type="number"
                min={1}
                max={20}
                value={reps}
                disabled={running}
                onChange={(event) =>
                  setReps(
                    Math.max(
                      1,
                      Math.min(20, Math.round(Number(event.target.value) || 1)),
                    ),
                  )
                }
              />
            </label>
            <span className="bench-note">
              Planned requests: {totalRequests}
            </span>
          </div>
          <dl>
            <div>
              <dt>Status</dt>
              <dd aria-live="polite">{progress}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                {results.length}/{totalRequests}
                {failureCount > 0 ? ` (${failureCount} failed)` : ''}
              </dd>
            </div>
          </dl>
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={
              running ||
              selectedProviders.size === 0 ||
              selectedFixtures.size === 0
            }
            onClick={() => void start()}
          >
            Start benchmark
          </button>
          <button disabled={!running} onClick={stop}>
            Stop
          </button>
        </div>
      </section>

      <section aria-labelledby="results-heading">
        <div className="section-heading">
          <h2 id="results-heading">Provider summary</h2>
          <button disabled={results.length === 0} onClick={download}>
            Download JSON
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Samples</th>
                <th>Errors</th>
                <th>JSON ok</th>
                <th>Schema ok</th>
                <th>Changed acc.</th>
                <th>Event hit</th>
                <th>p50 / p95</th>
                <th>Tokens in / out</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={summary.providerId}>
                  <th>
                    {summary.providerId}
                    <div className="provider-model">{summary.model}</div>
                  </th>
                  <td>{summary.sampleCount}</td>
                  <td>{summary.errorCount}</td>
                  <td>
                    {formatRatio(summary.jsonOkCount, summary.sampleCount)}
                  </td>
                  <td>
                    {formatRatio(summary.parseOkCount, summary.sampleCount)}
                  </td>
                  <td>
                    {formatRatio(
                      summary.changedCorrectCount,
                      summary.changedScoreCount,
                    )}
                  </td>
                  <td>
                    {formatRatio(
                      summary.eventHitCount,
                      summary.eventScoreCount,
                    )}
                  </td>
                  <td>
                    {formatLatency(summary.latencyP50Ms)} /{' '}
                    {formatLatency(summary.latencyP95Ms)}
                  </td>
                  <td>
                    {summary.inputTokens} / {summary.outputTokens}
                  </td>
                  <td>{formatCost(summary.estimatedCostUsd)}</td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    No measured run yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="bench-note">
          Changed accuracy and event hit are only scored for fixtures with
          meta.json expectations. Cost is a rough estimate from list prices and
          excludes cached-token discounts.
        </p>
      </section>

      <section aria-labelledby="log-heading">
        <h2 id="log-heading">Sample log</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fixture</th>
                <th>Provider</th>
                <th>Latency</th>
                <th>Changed</th>
                <th>Events</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {[...results].reverse().slice(0, 100).map((result, index) => (
                <tr key={`${result.providerId}-${result.fixtureId}-${index}`}>
                  <th>{result.fixtureId}</th>
                  <td>{result.providerId}</td>
                  <td>{result.latencyMs} ms</td>
                  <td>
                    <ChangedBadge result={result} />
                    {result.error && (
                      <span className="badge bad"> {result.error.kind}</span>
                    )}
                  </td>
                  <td className="obs-cell">
                    {result.observation?.events
                      .map((event) => event.kind)
                      .join(', ') || '—'}
                  </td>
                  <td className="obs-cell">
                    {result.error?.message ??
                      result.observation?.changeSummary ??
                      result.rawText?.slice(0, 120) ??
                      '—'}
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No samples yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StreamBenchmarkApp />);
