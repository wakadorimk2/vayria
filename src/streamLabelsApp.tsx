import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiUrl } from './runtimeConfig.js';
import type {
  StreamBenchFixtureSummary,
  StreamBenchLabelRequest,
} from './stream/streamContract.js';
import { STREAM_BENCH_PATH } from './stream/streamContract.js';
import './ttsBenchmark.css';
import './streamLabels.css';

interface FixtureListResponse {
  root: string;
  fixtures: StreamBenchFixtureSummary[];
}

interface EventKindsResponse {
  eventKinds: string[];
}

function frameUrl(fixtureId: string, which: string): string {
  return apiUrl(
    `${STREAM_BENCH_PATH}/fixture-image?id=${encodeURIComponent(fixtureId)}&which=${encodeURIComponent(which)}`,
  );
}

function suggestedCategory(changed: boolean | null, kinds: Set<string>): string {
  const first = [...kinds][0];
  if (first) return first;
  if (changed === false) return 'static';
  return 'other';
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
  );
}

interface LabelEditorProps {
  fixture: StreamBenchFixtureSummary;
  eventKinds: string[];
  onSaved: (fixture: StreamBenchFixtureSummary) => void;
}

function LabelEditor({ fixture, eventKinds, onSaved }: LabelEditorProps) {
  const [changed, setChanged] = useState<boolean | null>(
    fixture.expectedChanged,
  );
  const [kinds, setKinds] = useState<Set<string>>(
    new Set(fixture.expectedEventKinds),
  );
  const [category, setCategory] = useState(
    fixture.category === 'uncategorized' || fixture.category === 'auto'
      ? ''
      : fixture.category,
  );
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [notes, setNotes] = useState(fixture.notes);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [zoomedFrame, setZoomedFrame] = useState<string | null>(null);
  const midKeys = Array.from(
    { length: fixture.midCount ?? 0 },
    (_, index) => `mid-${index + 1}`,
  );

  const applyChanged = (value: boolean) => {
    setChanged(value);
    if (!categoryTouched) setCategory(suggestedCategory(value, kinds));
  };

  const toggleKind = (kind: string) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      if (!categoryTouched) setCategory(suggestedCategory(changed, next));
      return next;
    });
  };

  const save = useCallback(async () => {
    if (changed === null || saving) return;
    setSaving(true);
    setSaveError(null);
    const body: StreamBenchLabelRequest = {
      fixtureId: fixture.id,
      expectedChanged: changed,
      expectedEventKinds: [...kinds],
      category: category.trim() || suggestedCategory(changed, kinds),
      notes,
    };
    try {
      const response = await fetch(apiUrl(`${STREAM_BENCH_PATH}/label`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        fixture?: StreamBenchFixtureSummary;
        error?: string;
      } | null;
      if (!response.ok || !payload?.fixture) {
        setSaveError(payload?.error ?? `HTTP ${response.status}`);
        return;
      }
      onSaved(payload.fixture);
    } catch {
      setSaveError('Failed to reach the labeling API.');
    } finally {
      setSaving(false);
    }
  }, [fixture.id, changed, kinds, category, notes, saving, onSaved]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Enter') void save();
      else if (event.key === 'c') applyChanged(true);
      else if (event.key === 's') applyChanged(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section aria-labelledby="fixture-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Fixture</p>
          <h2 id="fixture-heading">{fixture.id}</h2>
        </div>
        <span
          className={`review-state ${fixture.reviewed ? 'done' : 'draft'}`}
        >
          {fixture.reviewed
            ? 'reviewed'
            : `draft${fixture.labelModel ? `: ${fixture.labelModel}` : ''}`}
        </span>
      </div>
      <p className="label-meta">
        {fixture.source && (
          <>
            <span>session {fixture.source.session}</span>
            <span>
              t={fixture.source.beforeSec}s → {fixture.source.afterSec}s
            </span>
            <span>diff {fixture.source.diffScore.toFixed(3)}</span>
          </>
        )}
      </p>
      <div className="label-frames">
        <figure>
          <img
            src={frameUrl(fixture.id, 'before')}
            alt="first frame"
            onClick={() => setZoomedFrame('before')}
          />
          <figcaption>F1</figcaption>
        </figure>
        {midKeys.map((key) => (
          <figure key={key} className="mid">
            <img
              src={frameUrl(fixture.id, key)}
              alt={`${key} frame`}
              onClick={() => setZoomedFrame(key)}
            />
            <figcaption>{key}</figcaption>
          </figure>
        ))}
        <figure>
          <img
            src={frameUrl(fixture.id, 'after')}
            alt="last frame"
            onClick={() => setZoomedFrame('after')}
          />
          <figcaption>F{2 + midKeys.length}</figcaption>
        </figure>
      </div>
      {midKeys.length > 0 && (
        <div className="label-sheet">
          <img
            src={frameUrl(fixture.id, 'sheet')}
            alt="contact sheet"
            onClick={() => setZoomedFrame('sheet')}
          />
          <p className="sheet-note">
            Contact sheet — this single image is what the VLM receives.
          </p>
        </div>
      )}
      {zoomedFrame && (
        <div
          className="frame-modal"
          role="dialog"
          aria-label={`${zoomedFrame} enlarged`}
          onClick={() => setZoomedFrame(null)}
        >
          <img src={frameUrl(fixture.id, zoomedFrame)} alt={zoomedFrame} />
        </div>
      )}

      <div className="run-panel">
        <div className="label-fields">
          <div>
            <div className="section-kicker">Changed?</div>
            <div className="changed-toggle">
              <button
                className={changed === true ? 'active-yes' : ''}
                onClick={() => applyChanged(true)}
              >
                changed (c)
              </button>
              <button
                className={changed === false ? 'active-no' : ''}
                onClick={() => applyChanged(false)}
              >
                static (s)
              </button>
            </div>
          </div>
          <div>
            <div className="section-kicker">Event kinds</div>
            <div className="kind-chips">
              {eventKinds.map((kind) => (
                <button
                  key={kind}
                  className={`kind-chip ${kinds.has(kind) ? 'on' : ''}`}
                  onClick={() => toggleKind(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
          </div>
          <label>
            Category
            <input
              type="text"
              value={category}
              placeholder={suggestedCategory(changed, kinds)}
              onChange={(event) => {
                setCategory(event.target.value);
                setCategoryTouched(true);
              }}
            />
          </label>
          <label>
            Notes
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
        <div className="label-actions">
          <button
            className="primary"
            disabled={changed === null || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save & next (Enter)'}
          </button>
          {saveError && (
            <span className="error" role="alert">
              {saveError}
            </span>
          )}
          <span className="hint">
            ←/→ navigate · c = changed · s = static · Enter = save
          </span>
        </div>
      </div>
    </section>
  );
}

export function StreamLabelsApp() {
  const [fixtures, setFixtures] = useState<StreamBenchFixtureSummary[]>([]);
  const [eventKinds, setEventKinds] = useState<string[]>([]);
  const [unreviewedOnly, setUnreviewedOnly] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [fixtureResponse, kindsResponse] = await Promise.all([
          fetch(apiUrl(`${STREAM_BENCH_PATH}/fixtures`)),
          fetch(apiUrl(`${STREAM_BENCH_PATH}/event-kinds`)),
        ]);
        if (!fixtureResponse.ok || !kindsResponse.ok) {
          setLoadError(
            'VLM benchmark API is unavailable. Start the dev server with VAYRIA_STREAM_BENCH=true.',
          );
          return;
        }
        const fixtureData = (await fixtureResponse.json()) as FixtureListResponse;
        const kindsData = (await kindsResponse.json()) as EventKindsResponse;
        setFixtures(fixtureData.fixtures);
        setEventKinds(kindsData.eventKinds);
      } catch {
        setLoadError(
          'VLM benchmark API is unreachable. Start the dev server with VAYRIA_STREAM_BENCH=true.',
        );
      }
    })();
  }, []);

  const visible = unreviewedOnly
    ? fixtures.filter((fixture) => !fixture.reviewed)
    : fixtures;
  const index = Math.min(cursor, Math.max(0, visible.length - 1));
  const fixture = visible[index];
  const reviewedCount = fixtures.filter((f) => f.reviewed).length;

  const onSaved = useCallback((updated: StreamBenchFixtureSummary) => {
    setFixtures((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    // Keep the index: the saved fixture drops out of the unreviewed filter,
    // so the next unreviewed fixture slides into place automatically.
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      else if (event.key === 'ArrowRight')
        setCursor((c) => Math.min(visible.length - 1, c + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <main>
      <header>
        <p className="eyebrow">Vayria development tool</p>
        <h1>Stream fixture labeling</h1>
        <p className="lede">
          Review draft labels on before/after frame pairs. Drafts come from a
          vision model; saving marks the fixture as human-reviewed.
        </p>
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
      </header>

      <section className="label-toolbar" aria-label="Progress and navigation">
        <div className="label-progress">
          <div className="track">
            <div
              className="fill"
              style={{
                width: `${fixtures.length ? (reviewedCount / fixtures.length) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="count">
            {reviewedCount}/{fixtures.length} reviewed
          </div>
        </div>
        <label className="reps-field">
          <input
            type="checkbox"
            checked={unreviewedOnly}
            onChange={(event) => {
              setUnreviewedOnly(event.target.checked);
              setCursor(0);
            }}
          />
          Unreviewed only
        </label>
        <div className="label-nav">
          <button disabled={index <= 0} onClick={() => setCursor(index - 1)}>
            ← Prev
          </button>
          <select
            value={fixture?.id ?? ''}
            onChange={(event) => {
              const next = visible.findIndex(
                (item) => item.id === event.target.value,
              );
              if (next >= 0) setCursor(next);
            }}
          >
            {visible.map((item, i) => (
              <option key={item.id} value={item.id}>
                {i + 1}. {item.id}
                {item.reviewed ? ' ✓' : ''}
              </option>
            ))}
          </select>
          <button
            disabled={index >= visible.length - 1}
            onClick={() => setCursor(index + 1)}
          >
            Next →
          </button>
        </div>
      </section>

      {fixture ? (
        <LabelEditor
          key={fixture.id}
          fixture={fixture}
          eventKinds={eventKinds}
          onSaved={onSaved}
        />
      ) : (
        <section>
          <p className="bench-note">
            {fixtures.length === 0 && !loadError
              ? 'No fixtures found under stream-bench/fixtures.'
              : 'All fixtures reviewed. Uncheck “Unreviewed only” to browse.'}
          </p>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StreamLabelsApp />);
