# Stream VLM benchmark (Phase 0)

Compares vision-language providers for the Stream Mode observation pipeline.
Each request sends a **single contact-sheet image** of a short frame
sequence (a few seconds) and expects a structured observation (`changed`,
events, scene, player state).

## Requirements

- Dev server started with the benchmark flag and provider keys:

  ```powershell
  # .env.local or environment
  VAYRIA_STREAM_BENCH=true
  OPENAI_API_KEY=...        # via npm run dev:op, or plain env
  GROQ_API_KEY=...          # optional
  GEMINI_API_KEY=...        # optional (GOOGLE_API_KEY also accepted)
  DEEPSEEK_API_KEY=...      # optional
  VAYRIA_STREAM_BENCH_ROOT= # optional, defaults to stream-bench/fixtures
  ```

- The endpoint group `/api/stream/vlm-bench` is only registered when
  `VAYRIA_STREAM_BENCH=true` and `VITE_APP_MODE` is `local`.

## Fixture format

One directory per fixture under `stream-bench/fixtures/`:

```text
stream-bench/fixtures/<fixture-id>/
  before.jpg         # first frame of the window
  mid-1.jpg..mid-3.jpg  # intermediate frames (optional)
  after.jpg          # last frame of the window
  contact-sheet.jpg  # labeled strip sent to the VLM (optional; composed if missing)
  meta.json          # optional expectations
```

- `fixture-id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- A fixture is a short frame **sequence**, not just a pair: the frames span a
  few seconds so brief events (enemy appears, menu opens, hit flash) stay
  visible.
- The provider request sends ONE image: a horizontal contact sheet of the
  frames labeled `F1 <t>s … Fn <t>s` (built by
  `server/stream/contactSheet.ts`). Fixtures without `contact-sheet.jpg`
  get one composed on the fly from before/mid-*/after. The sheet is capped
  at 2048 px width JPEG q80, so provider payloads stay comparable.

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

### From Steam Game Recording

`scripts/extract-stream-fixtures.mjs` turns Steam background recordings
(DASH chunks under `userdata/<id>/gamerecordings/video/bg_<appid>_*/`) into
fixture candidates:

```powershell
node scripts/extract-stream-fixtures.mjs --window 3 --frames 5 --cap 120 --negatives 20
```

```powershell
node scripts/extract-stream-fixtures.mjs --window 3 --frames 5 --cap 120 --negatives 20
```

Each Steam chunk is a 3 s segment starting with a keyframe, so one fixture =
one chunk = a 3 s window: `init + chunk` is piped to ffmpeg, an `fps` filter
emits `--frames` evenly spaced frames (default 5 ≈ every 0.6 s), and the
window is scored by the pixel difference between its first and last frame.
Windows are scanned across the whole recording, then `--cap` high-scoring
windows plus `--negatives` near-static ones (`expectedChanged: false`) are
written as fixtures with a prebuilt `contact-sheet.jpg`. Options:
`--recordings-root`, `--session` (substring filter), `--out`, `--dry-run`,
`--static-threshold`. `auto-*` directories are regenerated; hand-made
fixture directories are kept.

## Labeling fixtures

Generated `meta.json` values need ground truth. Two steps:

1. **Draft with a model** (optional but fast). `scripts/label-stream-fixtures.mjs`
   sends every fixture's contact sheet to a vision model and fills in `expectedChanged`,
   `expectedEventKinds`, `category`, and `notes`, marking each entry with a
   `labelDraft` block (`reviewed: false`). Use a model that is NOT a benchmark
   candidate — the default is `gpt-5-mini` — so accuracy scores measure the
   providers against an independent labeler plus human review, not
   self-agreement.

   ```powershell
   pwsh -NoProfile -File scripts/Start-VayriaWithOnePassword.ps1 `
     -CommandPath node -CommandArguments "scripts/label-stream-fixtures.mjs"
   # options: --model gpt-5-mini --limit 10 --concurrency 3 --force --dry-run
   ```

   The script needs `OPENAI_API_KEY` in the environment; the op wrapper or a
   plain exported variable both work.

2. **Review visually** at `/stream-labels.html` (dev server with
   `VAYRIA_STREAM_BENCH=true`). It shows the pair at full size with the draft
   values prefilled: toggle changed/static, adjust event-kind chips, edit
   notes, then Save & next (`Enter`). Saving POSTs to
   `POST /api/stream/vlm-bench/label`, which merges the fields into
   `meta.json` and flips `labelDraft.reviewed` to `true`. Keyboard: `←`/`→`
   navigate, `c` = changed, `s` = static. The progress bar and the
   "Unreviewed only" filter track what remains.

## Running the benchmark

Browser UI (recommended for inspection):

```text
http://localhost:<port>/stream-benchmark.html
```

Select providers and fixtures, set repetitions, run, download the JSON report.

Headless sweep (needs the dev server running):

```powershell
node scripts/run-stream-vlm-bench.mjs --port 5189 --reps 3 --providers openai-nano,openai-mini,gemini-flash-lite,groq-vision
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

## Provider notes

- `openai-nano` — `gpt-5-nano`, `reasoning_effort: minimal`.
- `openai-mini` — `gpt-5-mini`, `reasoning_effort: low`.
- `gemini-flash-lite` — `gemini-3.5-flash-lite` (gemini-2.5-flash-lite was
  retired). `responseSchema` is converted to the Gemini subset by
  `toGeminiSchema`; `thinkingBudget: 0` is rejected by gemini-3.5, so no
  thinking config is sent. Free-tier rate limits apply: `postJson` retries
  HTTP 429 up to 3 times with Retry-After/exponential backoff.
- `groq-vision` — `qwen/qwen3.8-27b`, Groq's only vision-capable model
  (Llama 4 multimodal retired 2026-07-17, qwen3.6 replaced by 3.8 on
  2026-09-14). Free tier is ~30 RPM; a dev account removes the 429 churn.
  It is the fastest provider but under-detects changes (27 false
  negatives vs 8 false positives on this fixture set).
- `deepseek-vision` — `deepseek-flash` (DeepSeek V4.1-Flash). OpenAI-
  compatible but without strict `json_schema`, so it uses
  `response_format: json_object` and receives the schema inline in the
  prompt; conformance is validated client-side. Thinking mode is
  disabled for latency parity. Defaults to `image detail: low`;
  `--detail high` overrides per run. Peak-tier list prices are used for
  the estimate (off-peak is half).

The sweep runner accepts `--detail low|high` to override the image
detail sent to providers that support it.

## Latest results (2026-09-26, 122 reviewed fixtures, 1 rep)

| provider | errors | changed acc | event hit | p50 | p95 | est. cost |
|---|---|---|---|---|---|---|
| openai-nano (gpt-5-nano) | 0 | 115/122 (94%) | 94/107 (88%) | 1701ms | 2356ms | $0.0154 |
| openai-mini (gpt-5-mini) | 0 | 110/122 (90%) | 87/107 (81%) | 3577ms | 5218ms | $0.1130 |
| gemini-flash-lite (gemini-3.5-flash-lite) | 2 | 109/122 (89%) | 60/107 (56%) | 1841ms | 5912ms | $0.0221 |
| groq-vision (qwen/qwen3.8-27b) | 0 | 87/122 (71%) | 54/107 (50%) | 881ms | 1167ms | $0.2940 |
| deepseek-vision (deepseek-flash, detail low) | 0 | 106/122 (87%) | 70/107 (65%) | 511ms | 618ms | $0.0450 |
| deepseek-vision (deepseek-flash, detail high) | 0 | 108/122 (89%) | 85/107 (79%) | 554ms | 670ms | $0.0563 |

False-negative counts for `changed` (missed real changes — the failure
mode that matters for silence): gpt-5-nano 2, deepseek-flash (high) 6,
gemini-3.5 10, gpt-5-mini 11, deepseek-flash (low) 14, qwen3.8-27b 27.
False positives: gpt-5-mini 1, gemini 1, deepseek (low) 2, nano 5,
groq 8, deepseek (high) 8.

`detail: high` trades a few false positives for a large FN and
event-hit improvement at ~8% added latency — the realistic choice for
this workload. DeepSeek at high detail is ~3x faster than gpt-5-nano
with near-par accuracy (89% vs 94% changed, 79% vs 88% event hit).

Reports: `stream-bench/results/stream-vlm-bench-3providers-*.json`,
`stream-vlm-bench-gemini-*.json`, `stream-vlm-bench-groq-*.json`,
`stream-vlm-bench-deepseek-*.json`,
`stream-vlm-bench-deepseek-high.json`,
`stream-vlm-bench-deepseek-high-full-*.json`.
