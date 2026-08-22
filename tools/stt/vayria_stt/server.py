from __future__ import annotations

import argparse
import asyncio
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .transcriber import (
    FasterWhisperTranscriber,
    Transcriber,
    TranscriptionResult,
)
from .vad import (
    CHANNELS,
    PcmUtteranceDetector,
    SAMPLE_RATE,
    WebRtcSpeechClassifier,
)

MAX_MESSAGE_BYTES = 64 * 1024
SUPPORTED_FORMAT = "pcm_s16le"
SUPPORTED_CHUNK_MS = 200


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


def _timestamp() -> int:
    return int(time.time() * 1_000)


def _parse_start(payload: Any) -> StreamConfig:
    if not isinstance(payload, dict) or payload.get("type") != "start":
        raise WireProtocolError("invalid-start-message")
    required = {"type", "language", "sampleRate", "channels", "format", "chunkMs"}
    if set(payload) - required - {"diagnostics"} or not required.issubset(payload):
        raise WireProtocolError("invalid-start-message")
    language = payload["language"]
    sample_rate = payload["sampleRate"]
    channels = payload["channels"]
    audio_format = payload["format"]
    chunk_ms = payload["chunkMs"]
    diagnostics = payload.get("diagnostics", False)
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
        or not isinstance(diagnostics, bool)
    ):
        raise WireProtocolError("unsupported-audio-format")
    normalized_language = language.split("-", 1)[0].lower()
    return StreamConfig(
        normalized_language,
        sample_rate,
        channels,
        audio_format,
        chunk_ms,
        diagnostics,
    )


async def _send_event(connection: ServerConnection, payload: dict[str, Any]) -> None:
    await connection.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


async def _transcription_worker(
    connection: ServerConnection,
    queue: asyncio.Queue[tuple[str, bytes]],
    transcriber: Transcriber,
    language: str,
    diagnostics: bool,
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
) -> None:
    detector: PcmUtteranceDetector | None = None
    worker: asyncio.Task[None] | None = None
    queue: asyncio.Queue[tuple[str, bytes]] | None = None
    try:
        first_message = await connection.recv()
        if not isinstance(first_message, str) or len(first_message.encode()) > MAX_MESSAGE_BYTES:
            raise WireProtocolError("invalid-start-message")
        try:
            start_payload = json.loads(first_message)
        except json.JSONDecodeError as error:
            raise WireProtocolError("invalid-start-message") from error
        config = _parse_start(start_payload)
        detector = PcmUtteranceDetector(classifier=WebRtcSpeechClassifier())
        queue = asyncio.Queue()
        worker = asyncio.create_task(
            _transcription_worker(
                connection,
                queue,
                transcriber,
                config.language,
                config.diagnostics,
            )
        )
        await _send_event(connection, {"type": "listening_started", "at": _timestamp()})

        async for message in connection:
            if isinstance(message, str):
                if len(message.encode()) > MAX_MESSAGE_BYTES:
                    raise WireProtocolError("message-too-large")
                try:
                    control = json.loads(message)
                except json.JSONDecodeError as error:
                    raise WireProtocolError("invalid-control-message") from error
                if control != {"type": "stop"}:
                    raise WireProtocolError("invalid-control-message")
                for event in detector.flush():
                    await _handle_detector_event(connection, queue, event)
                break

            if not isinstance(message, bytes) or len(message) > MAX_MESSAGE_BYTES:
                raise WireProtocolError("invalid-pcm-frame")
            for event in detector.feed(message):
                await _handle_detector_event(connection, queue, event)

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
        await queue.put((event.segment_id, event.audio))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Vayria PCM STT service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--compute-type", default="int8")
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    transcriber = FasterWhisperTranscriber(
        model_name=args.model,
        device="cpu",
        compute_type=args.compute_type,
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
