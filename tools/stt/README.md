# Vayria local STT service

This service accepts 16 kHz mono PCM16 WebSocket frames on localhost.

The Vayria browser sends the following wire messages:

1. JSON `start` with `language`, `sampleRate`, `channels`, `format`, and `chunkMs`.
2. Binary PCM16 frames.
3. JSON `stop` when the microphone stops.

The service uses WebRTC VAD with 20 ms frames. It emits `speech_started` after
two speech frames. It emits `speech_ended` and starts batch transcription after
600 ms of silence. It emits `utterance_finalized` after faster-whisper returns.

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

The first transcription downloads the configured faster-whisper model into the
model cache. The default model is `small`, with Japanese and CPU `int8` mode.
