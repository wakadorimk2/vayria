from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .transcriber import (
    DEFAULT_BEAM_SIZE,
    DEFAULT_HOTWORDS,
    DEFAULT_TEMPERATURES,
    FasterWhisperTranscriber,
    STT_BEAM_SIZE_VALUES,
    STT_COMPUTE_TYPE_VALUES,
    STT_DEVICE_VALUES,
    STT_FALLBACK_MODEL_VALUES,
    STT_MODEL_VALUES,
    Transcriber,
    TranscriptionResult,
)
from .vad import (
    CHANNELS,
    FRAME_DURATION_MS,
    PcmUtteranceDetector,
    SAMPLE_RATE,
    SpeechClassifier,
    WebRtcSpeechClassifier,
)
from .capture import DEFAULT_CAPTURE_DIR, SttCaptureWriter

MAX_MESSAGE_BYTES = 64 * 1024
SUPPORTED_FORMAT = "pcm_s16le"
SUPPORTED_CHUNK_MS = 200
END_SILENCE_MS_VALUES = (400, 600)
DEFAULT_END_SILENCE_MS = 600
CONTROL_MESSAGE_TYPES = {"speech_started", "speech_ended", "stop"}


class WireProtocolError(Exception):
    pass


@dataclass(frozen=True)
class StreamConfig:
    language: str
    sample_rate: int
    channels: int
    audio_format: str
    chunk_ms: int
    diagnostics: bool = False
    end_silence_ms: int = DEFAULT_END_SILENCE_MS
    capture_audio: bool = False


def _timestamp() -> int:
    return int(time.time() * 1_000)


def _parse_start(payload: Any) -> StreamConfig:
    if not isinstance(payload, dict) or payload.get("type") != "start":
        raise WireProtocolError("invalid-start-message")
    required = {"type", "language", "sampleRate", "channels", "format", "chunkMs"}
    if (
        set(payload) - required - {"diagnostics", "endSilenceMs", "captureAudio"}
        or not required.issubset(payload)
    ):
        raise WireProtocolError("invalid-start-message")
    language = payload["language"]
    sample_rate = payload["sampleRate"]
    channels = payload["channels"]
    audio_format = payload["format"]
    chunk_ms = payload["chunkMs"]
    end_silence_ms = payload.get("endSilenceMs", DEFAULT_END_SILENCE_MS)
    diagnostics = payload.get("diagnostics", False)
    capture_audio = payload.get("captureAudio", False)
    if (
        not isinstance(language, str)
        or not language
        or not isinstance(sample_rate, int)
        or sample_rate != SAMPLE_RATE
        or not isinstance(channels, int)
        or channels != CHANNELS
        or audio_format != SUPPORTED_FORMAT
        or not isinstance(chunk_ms, int)
        or chunk_ms != SUPPORTED_CHUNK_MS
        or isinstance(end_silence_ms, bool)
        or not isinstance(end_silence_ms, int)
        or end_silence_ms not in END_SILENCE_MS_VALUES
        or not isinstance(diagnostics, bool)
        or not isinstance(capture_audio, bool)
    ):
        raise WireProtocolError("unsupported-audio-format")
    normalized_language = language.split("-", 1)[0].lower()
    return StreamConfig(
        language=normalized_language,
        sample_rate=sample_rate,
        channels=channels,
        audio_format=audio_format,
        chunk_ms=chunk_ms,
        diagnostics=diagnostics,
        end_silence_ms=end_silence_ms,
        capture_audio=capture_audio,
    )


def _parse_control(payload: Any) -> str:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"type"}
        or payload.get("type") not in CONTROL_MESSAGE_TYPES
    ):
        raise WireProtocolError("invalid-control-message")
    return payload["type"]


async def _send_event(connection: ServerConnection, payload: dict[str, Any]) -> None:
    await connection.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


async def _transcription_worker(
    connection: ServerConnection,
    queue: asyncio.Queue[tuple[str, bytes]],
    transcriber: Transcriber,
    language: str,
    diagnostics: bool,
    capture_writer: SttCaptureWriter | None = None,
) -> None:
    while True:
        segment_id, pcm = await queue.get()
        try:
            if diagnostics:
                await _send_event(
                    connection,
                    {
                        "type": "stt_started",
                        "segmentId": segment_id,
                        "at": _timestamp(),
                    },
                )
            diagnostic_transcriber = getattr(
                transcriber,
                "transcribe_pcm16_with_diagnostics",
                None,
            )
            if callable(diagnostic_transcriber):
                result = await asyncio.to_thread(
                    diagnostic_transcriber,
                    pcm,
                    sample_rate=SAMPLE_RATE,
                    language=language,
                )
            else:
                text = await asyncio.to_thread(
                    transcriber.transcribe_pcm16,
                    pcm,
                    sample_rate=SAMPLE_RATE,
                    language=language,
                )
                result = TranscriptionResult(text, text, None)
            if capture_writer is not None:
                capture_writer.write(segment_id, pcm, result)
            if diagnostics:
                observed = {
                    "type": "stt_observed",
                    "segmentId": segment_id,
                    "rawText": result.raw_text,
                    "acceptedText": result.text,
                    "at": _timestamp(),
                }
                if result.filter_reason is not None:
                    observed["filterReason"] = result.filter_reason
                await _send_event(connection, observed)
            await _send_event(
                connection,
                {
                    "type": "utterance_finalized",
                    "segmentId": segment_id,
                    "text": result.text,
                    "at": _timestamp(),
                },
            )
        except ConnectionClosed:
            return
        except Exception:
            with suppress(ConnectionClosed):
                await _send_event(
                    connection,
                    {
                        "type": "recognition_failed",
                        "code": "stt-unavailable",
                        "at": _timestamp(),
                    },
                )
        finally:
            del pcm
            queue.task_done()


async def handle_connection(
    connection: ServerConnection,
    *,
    transcriber: Transcriber,
    classifier: SpeechClassifier | None = None,
    capture_dir: Path = DEFAULT_CAPTURE_DIR,
) -> None:
    detector: PcmUtteranceDetector | None = None
    worker: asyncio.Task[None] | None = None
    queue: asyncio.Queue[tuple[str, bytes]] | None = None
    capture_writer: SttCaptureWriter | None = None
    try:
        first_message = await connection.recv()
        if not isinstance(first_message, str) or len(first_message.encode()) > MAX_MESSAGE_BYTES:
            raise WireProtocolError("invalid-start-message")
        try:
            start_payload = json.loads(first_message)
        except json.JSONDecodeError as error:
            raise WireProtocolError("invalid-start-message") from error
        config = _parse_start(start_payload)
        if config.capture_audio:
            capture_writer = SttCaptureWriter(capture_dir)
            print(
                json.dumps(
                    {
                        "type": "stt_capture",
                        "directory": str(capture_writer.session_dir),
                        "maxSegments": capture_writer.max_segments,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        detector = PcmUtteranceDetector(
            classifier=classifier or WebRtcSpeechClassifier(),
            end_silence_frame_count=config.end_silence_ms // FRAME_DURATION_MS,
        )
        queue = asyncio.Queue()
        worker = asyncio.create_task(
            _transcription_worker(
                connection,
                queue,
                transcriber,
                config.language,
                config.diagnostics,
                capture_writer,
            )
        )
        if config.diagnostics:
            runtime_info = getattr(transcriber, "runtime_info", None)
            if callable(runtime_info):
                await _send_event(
                    connection,
                    {
                        "type": "stt_runtime",
                        "at": _timestamp(),
                        "runtime": runtime_info(),
                    },
                )
        await _send_event(connection, {"type": "listening_started", "at": _timestamp()})

        client_boundary_active = False
        server_segment_active = False

        async def handle_detector_events(events) -> None:
            nonlocal server_segment_active
            for event in events:
                if event.type == "speech_started":
                    server_segment_active = True
                elif event.type == "utterance_finalized":
                    server_segment_active = False
                await _handle_detector_event(
                    connection,
                    queue,
                    event,
                    diagnostics=config.diagnostics,
                )

        async def flush_detector() -> None:
            nonlocal client_boundary_active, server_segment_active
            await handle_detector_events(detector.flush())
            client_boundary_active = False
            server_segment_active = False

        while True:
            try:
                message = await asyncio.wait_for(
                    connection.recv(),
                    timeout=(config.end_silence_ms / 1_000)
                    if client_boundary_active or server_segment_active
                    else None,
                )
            except asyncio.TimeoutError:
                # A missing browser boundary must not leave a segment pending.
                # An idle session remains open because no timeout is armed then.
                await flush_detector()
                continue

            if isinstance(message, str):
                if len(message.encode()) > MAX_MESSAGE_BYTES:
                    raise WireProtocolError("message-too-large")
                try:
                    control_type = _parse_control(json.loads(message))
                except json.JSONDecodeError as error:
                    raise WireProtocolError("invalid-control-message") from error
                if control_type == "speech_started":
                    client_boundary_active = True
                    continue
                if control_type == "speech_ended":
                    await flush_detector()
                    continue
                await flush_detector()
                break

            if not isinstance(message, bytes) or len(message) > MAX_MESSAGE_BYTES:
                raise WireProtocolError("invalid-pcm-frame")
            await handle_detector_events(detector.feed(message))

        if queue is not None:
            await queue.join()
        await _send_event(connection, {"type": "recognition_stopped", "at": _timestamp()})
    except ConnectionClosed:
        return
    except WireProtocolError as error:
        with suppress(ConnectionClosed):
            await _send_event(
                connection,
                {
                    "type": "recognition_failed",
                    "code": str(error),
                    "at": _timestamp(),
                },
            )
    except Exception:
        with suppress(ConnectionClosed):
            await _send_event(
                connection,
                {
                    "type": "recognition_failed",
                    "code": "recognition-failed",
                    "at": _timestamp(),
                },
            )
    finally:
        if worker is not None:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker
        if detector is not None:
            detector.reset()


async def _handle_detector_event(
    connection: ServerConnection,
    queue: asyncio.Queue[tuple[str, bytes]],
    event,
    *,
    diagnostics: bool = False,
) -> None:
    if event.type == "speech_started":
        await _send_event(
            connection,
            {"type": "speech_started", "segmentId": event.segment_id, "at": _timestamp()},
        )
        return
    if event.type == "speech_ended":
        await _send_event(
            connection,
            {"type": "speech_ended", "segmentId": event.segment_id, "at": _timestamp()},
        )
        return
    if event.type == "utterance_finalized" and event.audio is not None:
        if diagnostics:
            await _send_event(
                connection,
                {
                    "type": "stt_queued",
                    "segmentId": event.segment_id,
                    "at": _timestamp(),
                },
            )
        await queue.put((event.segment_id, event.audio))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Vayria PCM STT service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--model", choices=STT_MODEL_VALUES, default="small")
    parser.add_argument("--language", default="ja")
    parser.add_argument(
        "--device",
        choices=STT_DEVICE_VALUES,
        default="auto",
    )
    parser.add_argument(
        "--compute-type",
        choices=STT_COMPUTE_TYPE_VALUES,
        default="auto",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        choices=STT_BEAM_SIZE_VALUES,
        default=DEFAULT_BEAM_SIZE,
    )
    parser.add_argument(
        "--temperatures",
        type=float,
        nargs="+",
        default=list(DEFAULT_TEMPERATURES),
    )
    parser.add_argument("--hotwords", default=DEFAULT_HOTWORDS)
    parser.add_argument(
        "--require-primary-profile",
        action="store_true",
        help="Fail startup instead of loading the comparison fallback profile.",
    )
    parser.add_argument(
        "--fallback-model",
        choices=STT_FALLBACK_MODEL_VALUES,
        default="tiny",
    )
    parser.add_argument(
        "--fallback-device",
        choices=("cuda", "cpu"),
        default="cpu",
    )
    parser.add_argument(
        "--fallback-compute-type",
        choices=STT_COMPUTE_TYPE_VALUES,
        default="int8",
    )
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    transcriber = FasterWhisperTranscriber(
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        fallback_model=args.fallback_model,
        fallback_device=args.fallback_device,
        fallback_compute_type=args.fallback_compute_type,
        beam_size=args.beam_size,
        temperatures=tuple(args.temperatures),
        hotwords=args.hotwords,
        require_primary_profile=args.require_primary_profile,
    )
    runtime = await asyncio.to_thread(transcriber.prepare)
    await asyncio.to_thread(transcriber.warm_up, args.language)
    print(
        json.dumps(
            {"type": "stt_runtime", "runtime": runtime},
            ensure_ascii=False,
        ),
        flush=True,
    )
    async with serve(
        lambda connection: handle_connection(connection, transcriber=transcriber),
        args.host,
        args.port,
        max_size=MAX_MESSAGE_BYTES,
        ping_interval=20,
        ping_timeout=20,
    ):
        await asyncio.Future()


def main() -> None:
    args = parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
