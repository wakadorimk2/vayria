# Vayria stream mode

Stream mode is a dedicated `APP_MODE` for long-running gameplay
streams. Vayria watches the shared game screen, detects meaningful
changes, and speaks through the existing autonomy pipeline — only
when there is something worth saying.

## Run

```text
npm run dev:stream        # vite --mode stream
npm run dev:stream:op     # same, with 1Password env injection
```

The page shows the normal avatar with a small `stream-panel` overlay.
Click **画面共有を開始** and pick the game window or screen — the
browser requires this manual gesture for `getDisplayMedia`. The panel
shows the last observation time, the latest change summary, and
consecutive error count.

## Pipeline

```text
getDisplayMedia
  -> GameCapture.captureWindow()   # 5 frames / ~2.4s -> labeled contact sheet
  -> staticFrameSkip               # luma diff on 64x36 grid, threshold 0.02
  -> POST /api/stream/observe      # JPEG body, provider=deepseek-vision (detail: high)
  -> StreamObserver                # significance filter + per-kind cooldown
  -> recordAutonomyEvidence        # kind=environment_change, semanticKey=game:7dtd:<kind>
  -> useAutonomousTalk             # existing gates decide speak|none
```

Three layers match the Phase 0 architecture decision:

- **Eye**: `deepseek-flash` at `detail: high` — p50 ~550ms
  observation latency, so reactions feel immediate.
- **Brain**: `gpt-5-nano` reserved for asynchronous verification and
  state correction; it does not gate the immediate reaction.
- **Brake**: static-frame skip, significance floor, per-event-kind
  cooldown, and the existing autonomy gates (mute, busy, turn gate,
  cooldown, deduplication by `semanticKey`).

## Endpoint

`POST /api/stream/observe?provider=<id>&detail=low|high`

- Body: image bytes (`Content-Type: image/*`), max 8 MB. The client
  sends the composited contact-sheet JPEG.
- Enabled when `config.mode === 'stream'` or
  `VAYRIA_STREAM_BENCH=true`; never in `public` mode.
- Response: `StreamObserveResult` — `{ observation, model,
  latencyMs, usage, error? }`. Provider failures return 200 with a
  structured `error` field so the observer can apply backoff without
  special-casing HTTP codes.

## Tuning

`StreamObserver` options (defaults in `streamObserver.ts`):

| option | default | meaning |
|---|---|---|
| `cadenceMs` | 10s | idle time between windows |
| `maxStaleMs` | 120s | re-observe even static scenes this often |
| `eventCooldownMs` | 180s | same event kind cannot refire within this |
| `minSignificance` | `medium` | events below this stay context-only |
| `staticThreshold` | 0.02 | luma-diff skip threshold |

## Context and prompts

Each observation updates `programContext.streamContext` (rolling
scene/player summary + last 6 event summaries). The system prompt
tells the model Vayria is a companion watching the game — she may
react briefly to notable developments, must not narrate routine
activity, must not repeat stale events, and may stay silent.

## Long-running notes

- `autonomyState.evidenceHistory` is capped at 512 entries.
- The document-visibility hard gate is relaxed in stream mode only
  (`ignoreVisibilityGate`), so the tab keeps working while OBS or the
  game has focus. All other hard gates remain.
- OBS Browser Source support (state hub, transparent overlay) is
  Phase 3 scope.
