# Stream VLM benchmark (Phase 0)

Compares vision-language providers for the Stream Mode observation pipeline.
Each request sends a **before/after frame pair** and expects a structured
observation (`changed`, events, scene, player state).

## Requirements

- Dev server started with the benchmark flag and provider keys:

  ```powershell
  # .env.local or environment
  VAYRIA_STREAM_BENCH=true
  OPENAI_API_KEY=...        # via npm run dev:op, or plain env
  GROQ_API_KEY=...          # optional
  GEMINI_API_KEY=...        # optional (GOOGLE_API_KEY also accepted)
  VAYRIA_STREAM_BENCH_ROOT= # optional, defaults to stream-bench/fixtures
  ```

- The endpoint group `/api/stream/vlm-bench` is only registered when
  `VAYRIA_STREAM_BENCH=true` and `VITE_APP_MODE` is `local`.

## Fixture format

One directory per fixture under `stream-bench/fixtures/`:

```text
stream-bench/fixtures/<fixture-id>/
  before.jpg      # earlier frame
  after.jpg       # later frame
  meta.json       # optional expectations
```

- `fixture-id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- Images: `jpg`, `jpeg`, `png`, or `webp`. The server downscales to 768 px
  width JPEG q80 before sending, so provider payloads stay comparable.

`meta.json`:

```json
{
  "category": "combat",
  "expectedChanged": true,
  "expectedEventKinds": ["enemy_visible", "combat"],
  "notes": "A zombie enters view on the right."
}
```

- `expectedChanged`: `true`, `false`, or omit for unscored fixtures.
- Use `expectedChanged: false` for **negative pairs** (viewpoint drift,
  HUD-only changes, unchanged ongoing activity).
- `expectedEventKinds` lists acceptable event kinds; a run scores a hit when
  any observed event kind intersects this list.

## Collecting fixtures

Diversity matters more than repetition. Capture pairs several seconds apart
across situations, for example:

- combat, mining/gathering, building, looting, driving
- day/dusk/night transitions, Blood Moon
- menu/inventory/map open and close, death and respawn screens
- indoor/outdoor/underground transitions
- negative pairs: aimless camera turns, idle moments, HUD-only changes

Any capture tool works (screenshots, OBS stills, game capture). Frames do not
need identical crops; the observation model compares semantic content.

## Running the benchmark

Browser UI (recommended for inspection):

```text
http://localhost:<port>/stream-benchmark.html
```

Select providers and fixtures, set repetitions, run, download the JSON report.

Headless sweep (needs the dev server running):

```powershell
node scripts/run-stream-vlm-bench.mjs --port 5189 --reps 3 --providers openai-nano,groq-vision,gemini-flash-lite
```

Writes `stream-bench/results/stream-vlm-bench-<timestamp>.json` and prints a
per-provider summary (sample count, errors, JSON/schema success, changed
accuracy, event-hit rate, p50/p95 latency, estimated cost).

Target: **50–100 requests per provider** for a meaningful p95, spread across a
diverse fixture set rather than a few images repeated.

## Metrics

- `jsonOk` — the provider returned parseable JSON.
- `parseOk` — the JSON also conforms to the observation schema.
- `changed accuracy` — `observation.changed` matches `expectedChanged`.
- `event hit` — any observed event kind is in `expectedEventKinds`.
- `latencyMs` — server-measured provider call time (p50/p95 in summaries).
- `estimatedCostUsd` — rough estimate from list prices; excludes caching.
