# Vayria local STT service

This service accepts 16 kHz mono PCM16 WebSocket frames on localhost.

The Vayria browser sends the following wire messages:

1. JSON `start` with `language`, `sampleRate`, `channels`, `format`, and `chunkMs`.
   Mode B/C may add `endSilenceMs: 400` or `endSilenceMs: 600`.
   Audio Lab may add `diagnostics: true`.
2. Binary PCM16 frames.
3. JSON `stop` when the microphone stops.

The service uses WebRTC VAD with 20 ms frames. It emits `speech_started` after
two speech frames. It emits `speech_ended` and starts batch transcription after
600 ms of silence by default. Mode B/C can request 400 ms. It emits
`stt_queued`, then `utterance_finalized` after faster-whisper returns.
`speech_ended` means that server VAD confirmed the endpoint. It does not mean
that a physical speaker stopped at that exact sample.
When diagnostics are enabled, it also emits `stt_runtime`, `stt_started`, and
`stt_observed`.
The diagnostic event includes raw and filtered text. The filtered text remains
the only text sent in `utterance_finalized`.

The service listens on `127.0.0.1` by default. It does not write audio files or
log audio content.

## Setup

Use Python 3.12 with `uv`:

```powershell
Push-Location tools/stt
uv sync --group dev
uv run --no-cache pytest
uv run --no-cache python -m vayria_stt.server
Pop-Location
```

The service loads and warms the configured faster-whisper model before it accepts
connections. The exhibition default requires `small / CUDA / float16`.
`--require-primary-profile` makes startup fail when that profile cannot load.
The comparison fallback remains available when that flag is omitted.
The actual model, device, compute type, fallback reason, model load time, and
decode settings are sent as `stt_runtime` when diagnostics are enabled.

The command line supports these comparison settings:

```powershell
uv run --no-cache python -m vayria_stt.server `
  --model small `
  --device cuda `
  --compute-type float16 `
  --beam-size 3 `
  --temperatures 0.0 0.2 `
  --hotwords "Vayria GPT-Live Codex" `
  --require-primary-profile `
  --fallback-model tiny `
  --fallback-device cpu `
  --fallback-compute-type int8
```

`--model` accepts `tiny`, `base`, or `small`.
`--device` accepts `auto`, `cuda`, or `cpu`.
`--compute-type` accepts `auto`, `float16`, `int8`, or `int8_float16`.
`--beam-size` accepts `1` or `3`.
The default decode settings are `beam_size=3`, `temperature=(0.0, 0.2)`,
`without_timestamps=True`, `condition_on_previous_text=False`, and
`vad_filter=False`.
The default hotwords are `Vayria GPT-Live Codex`.
The benchmark matrix is `small / float16`, `small / int8_float16`, and
`base / float16` on CUDA.

The local benchmark procedure is in
`tools/stt/benchmarks/README.md`. It does not add raw audio to Git.
