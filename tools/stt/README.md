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
connections. The exhibition default requests `small / CUDA / float16` and falls
back to `tiny / CPU / int8` when the primary model cannot load. The actual model,
device, compute type, fallback reason, and model load time are sent as
`stt_runtime` when diagnostics are enabled.

The command line supports these comparison settings:

```powershell
uv run --no-cache python -m vayria_stt.server `
  --model small `
  --device auto `
  --compute-type auto `
  --fallback-model tiny `
  --fallback-device cpu `
  --fallback-compute-type int8
```

`--model` accepts `tiny`, `base`, or `small`.
`--device` accepts `auto`, `cuda`, or `cpu`.
`--compute-type` accepts `auto`, `float16`, or `int8`.
The benchmark matrix is each model with CUDA and CPU.
