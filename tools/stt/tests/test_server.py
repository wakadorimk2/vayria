from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
from contextlib import suppress
import wave

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from vayria_stt.server import (
    DEFAULT_END_SILENCE_MS,
    END_SILENCE_MS_VALUES,
    SUPPORTED_CHUNK_MS,
    SUPPORTED_FORMAT,
    _handle_detector_event,
    _parse_control,
    _parse_start,
    _transcription_worker,
    handle_connection,
    parse_args,
)
from vayria_stt.capture import SttCaptureWriter
from vayria_stt.transcriber import FasterWhisperTranscriber, TranscriptionResult
from vayria_stt.vad import FRAME_BYTES, DetectorEvent


class FakeTranscriber:
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        return "テスト"


class DiagnosticTranscriber:
    def transcribe_pcm16_with_diagnostics(
        self,
        pcm: bytes,
        *,
        sample_rate: int,
        language: str,
    ) -> TranscriptionResult:
        return TranscriptionResult("raw text", "accepted text", "test-filter")


class RuntimeTranscriber(FakeTranscriber):
    def runtime_info(self) -> dict[str, object]:
        return {
            "requestedModel": "small",
            "requestedDevice": "auto",
            "requestedComputeType": "auto",
            "effectiveModel": "tiny",
            "effectiveDevice": "cpu",
            "effectiveComputeType": "int8",
            "fallbackUsed": True,
            "fallbackReason": "CUDA unavailable",
            "modelLoadMs": 123,
            "decodeBeamSize": 3,
            "decodeTemperatures": [0.0, 0.2],
            "decodeWithoutTimestamps": True,
            "decodeConditionOnPreviousText": False,
            "decodeVadFilter": False,
            "hotwords": "Vayria GPT-Live Codex",
            "primaryProfileRequired": False,
        }


class SequenceClassifier:
    def __init__(self, values: list[bool]) -> None:
        self.values = values

    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        assert len(frame) == FRAME_BYTES
        assert sample_rate == 16_000
        return self.values.pop(0)


def frame(value: int = 1) -> bytes:
    return bytes([value]) * FRAME_BYTES


class FakeConnection:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send(self, message: str) -> None:
        self.messages.append(message)


def test_parse_args_accepts_comparison_compute_type_and_primary_profile(monkeypatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "vayria-stt",
            "--compute-type",
            "int8_float16",
            "--hotwords",
            "Vayria GPT-Live Codex",
            "--require-primary-profile",
            "--beam-size",
            "1",
        ],
    )

    args = parse_args()

    assert args.compute_type == "int8_float16"
    assert args.hotwords == "Vayria GPT-Live Codex"
    assert args.require_primary_profile is True
    assert args.beam_size == 1
    assert args.temperatures == [0.0]


def test_parse_args_uses_formal_stt_defaults(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["vayria-stt"])

    args = parse_args()

    assert args.model == "medium"
    assert args.device == "cuda"
    assert args.compute_type == "float16"
    assert args.beam_size == 1
    assert args.temperatures == [0.0]
    assert args.hotwords == "Vayria GPT-Live Codex"


def test_parse_args_preserves_empty_hotwords_as_disabled(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["vayria-stt", "--hotwords", ""])

    args = parse_args()
    transcriber = FasterWhisperTranscriber(hotwords=args.hotwords)

    assert args.hotwords == ""
    assert transcriber.runtime_info()["hotwords"] is None


def test_start_message_can_enable_diagnostics() -> None:
    config = _parse_start(
        {
            "type": "start",
            "language": "ja-JP",
            "sampleRate": 16_000,
            "channels": 1,
            "format": SUPPORTED_FORMAT,
            "chunkMs": SUPPORTED_CHUNK_MS,
            "diagnostics": True,
        }
    )
    assert config.diagnostics is True
    assert config.end_silence_ms == DEFAULT_END_SILENCE_MS


def test_start_message_can_enable_local_stt_capture() -> None:
    config = _parse_start(
        {
            "type": "start",
            "language": "ja-JP",
            "sampleRate": 16_000,
            "channels": 1,
            "format": SUPPORTED_FORMAT,
            "chunkMs": SUPPORTED_CHUNK_MS,
            "captureAudio": True,
        }
    )

    assert config.capture_audio is True


def test_capture_writer_writes_wav_index_and_draft_manifest(tmp_path: Path) -> None:
    writer = SttCaptureWriter(tmp_path)
    pcm = b"\x01\x02" * 160
    path = writer.write(
        "voice-segment-test",
        pcm,
        TranscriptionResult("raw text", "accepted text", "test-filter"),
    )

    assert path is not None
    with wave.open(str(path), "rb") as audio_file:
        assert audio_file.getnchannels() == 1
        assert audio_file.getsampwidth() == 2
        assert audio_file.getframerate() == 16_000
        assert audio_file.readframes(audio_file.getnframes()) == pcm

    index = [
        json.loads(line)
        for line in writer.index_path.read_text(encoding="utf-8").splitlines()
    ]
    assert index[0]["segmentId"] == "voice-segment-test"
    assert index[0]["rawText"] == "raw text"
    assert index[0]["acceptedText"] == "accepted text"
    assert index[0]["filterReason"] == "test-filter"
    manifest = json.loads(writer.manifest_path.read_text(encoding="utf-8"))
    assert manifest["cases"] == [
        {
            "id": "segment-0001",
            "category": "uncategorized",
            "audio": "segment-0001.wav",
            "reference": "",
        }
    ]


def test_capture_writer_stops_at_ten_segments(tmp_path: Path) -> None:
    writer = SttCaptureWriter(tmp_path)
    result = TranscriptionResult("", "", "empty-audio")

    for index in range(10):
        assert writer.write(f"segment-{index}", b"\x00\x00", result) is not None
    assert writer.write("segment-11", b"\x00\x00", result) is None
    assert writer.count == 10
    assert len(list(writer.session_dir.glob("*.wav"))) == 10


def test_websocket_without_capture_does_not_create_capture_files(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with serve(
            lambda connection: handle_connection(
                connection,
                transcriber=FakeTranscriber(),
                capture_dir=tmp_path,
            ),
            "127.0.0.1",
            0,
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/stream") as client:
                await client.send(
                    json.dumps(
                        {
                            "type": "start",
                            "language": "ja-JP",
                            "sampleRate": 16_000,
                            "channels": 1,
                            "format": "pcm_s16le",
                            "chunkMs": 200,
                        }
                    )
                )
                assert json.loads(await client.recv())["type"] == "listening_started"
                await client.send(json.dumps({"type": "stop"}))
                assert json.loads(await client.recv())["type"] == "recognition_stopped"

    asyncio.run(scenario())
    assert list(tmp_path.iterdir()) == []


def test_start_message_accepts_only_supported_endpoint_values() -> None:
    base = {
        "type": "start",
        "language": "ja-JP",
        "sampleRate": 16_000,
        "channels": 1,
        "format": SUPPORTED_FORMAT,
        "chunkMs": SUPPORTED_CHUNK_MS,
    }
    for value in END_SILENCE_MS_VALUES:
        assert _parse_start({**base, "endSilenceMs": value}).end_silence_ms == value
    with pytest.raises(Exception):
        _parse_start({**base, "endSilenceMs": 500})


def test_boundary_control_messages_are_strict_and_known() -> None:
    assert [_parse_control({"type": value}) for value in (
        "speech_started",
        "speech_ended",
        "stop",
    )] == ["speech_started", "speech_ended", "stop"]
    with pytest.raises(Exception):
        _parse_control({"type": "unknown"})
    with pytest.raises(Exception):
        _parse_control({"type": "speech_ended", "segmentId": "client-id"})


def test_diagnostic_worker_emits_raw_and_filtered_transcript(tmp_path: Path) -> None:
    async def scenario() -> None:
        connection = FakeConnection()
        queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()
        capture_writer = SttCaptureWriter(tmp_path)
        await queue.put(("segment-1", b"\x00" * 6_400))
        worker = asyncio.create_task(
            _transcription_worker(
                connection,
                queue,
                DiagnosticTranscriber(),
                "ja",
                True,
                capture_writer,
            )
        )
        await queue.join()
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker

        payloads = [json.loads(message) for message in connection.messages]
        assert [payload["type"] for payload in payloads] == [
            "stt_started",
            "stt_observed",
            "utterance_finalized",
        ]
        assert payloads[1]["rawText"] == "raw text"
        assert payloads[1]["acceptedText"] == "accepted text"
        assert payloads[2]["text"] == "accepted text"
        index = [
            json.loads(line)
            for line in capture_writer.index_path.read_text(encoding="utf-8").splitlines()
        ]
        assert index[0]["rawText"] == "raw text"
        assert index[0]["acceptedText"] == "accepted text"

    asyncio.run(scenario())


def test_detector_event_emits_queue_diagnostic_before_queue_insert() -> None:
    async def scenario() -> None:
        connection = FakeConnection()
        queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()
        await _handle_detector_event(
            connection,
            queue,
            DetectorEvent("utterance_finalized", "segment-queued", b"pcm"),
            diagnostics=True,
        )
        payload = json.loads(connection.messages[0])
        assert payload["type"] == "stt_queued"
        assert payload["segmentId"] == "segment-queued"
        assert await queue.get() == ("segment-queued", b"pcm")

    asyncio.run(scenario())


def test_websocket_start_binary_stop_wire() -> None:
    async def scenario() -> None:
        async with serve(
            lambda connection: handle_connection(
                connection,
                transcriber=FakeTranscriber(),
            ),
            "127.0.0.1",
            0,
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/stream") as client:
                await client.send(
                    json.dumps(
                        {
                            "type": "start",
                            "language": "ja-JP",
                            "sampleRate": 16_000,
                            "channels": 1,
                            "format": "pcm_s16le",
                            "chunkMs": 200,
                        }
                    )
                )
                assert json.loads(await client.recv())["type"] == "listening_started"
                await client.send(b"\x00" * 6_400)
                await client.send(json.dumps({"type": "stop"}))
                assert json.loads(await client.recv())["type"] == "recognition_stopped"

    asyncio.run(scenario())


def test_boundary_end_flushes_stt_and_keeps_session_open() -> None:
    async def scenario() -> None:
        classifier = SequenceClassifier([True, True, True, True])
        async with serve(
            lambda connection: handle_connection(
                connection,
                transcriber=FakeTranscriber(),
                classifier=classifier,
            ),
            "127.0.0.1",
            0,
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/stream") as client:
                await client.send(
                    json.dumps(
                        {
                            "type": "start",
                            "language": "ja-JP",
                            "sampleRate": 16_000,
                            "channels": 1,
                            "format": "pcm_s16le",
                            "chunkMs": 200,
                        }
                    )
                )
                assert json.loads(await client.recv())["type"] == "listening_started"

                await client.send(json.dumps({"type": "speech_started"}))
                await client.send(frame(1))
                await client.send(frame(2))
                assert json.loads(await client.recv())["type"] == "speech_started"

                await client.send(json.dumps({"type": "speech_ended"}))
                assert json.loads(await client.recv())["type"] == "speech_ended"
                assert json.loads(await client.recv())["type"] == "utterance_finalized"
                await client.send(json.dumps({"type": "speech_ended"}))

                await client.send(json.dumps({"type": "speech_started"}))
                await client.send(frame(3))
                await client.send(frame(4))
                assert json.loads(await client.recv())["type"] == "speech_started"
                await client.send(json.dumps({"type": "speech_ended"}))
                assert json.loads(await client.recv())["type"] == "speech_ended"
                assert json.loads(await client.recv())["type"] == "utterance_finalized"

                await client.send(json.dumps({"type": "stop"}))
                assert json.loads(await client.recv())["type"] == "recognition_stopped"

    asyncio.run(scenario())


def test_missing_boundary_flushes_after_end_silence_timeout_and_keeps_session_open() -> None:
    async def scenario() -> None:
        classifier = SequenceClassifier([True, True])
        async with serve(
            lambda connection: handle_connection(
                connection,
                transcriber=FakeTranscriber(),
                classifier=classifier,
            ),
            "127.0.0.1",
            0,
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/stream") as client:
                await client.send(
                    json.dumps(
                        {
                            "type": "start",
                            "language": "ja-JP",
                            "sampleRate": 16_000,
                            "channels": 1,
                            "format": "pcm_s16le",
                            "chunkMs": 200,
                            "endSilenceMs": 400,
                        }
                    )
                )
                assert json.loads(await client.recv())["type"] == "listening_started"
                await client.send(json.dumps({"type": "speech_started"}))
                await client.send(frame())
                await client.send(frame())
                assert json.loads(await client.recv())["type"] == "speech_started"

                timeout_event = json.loads(await asyncio.wait_for(client.recv(), 1.5))
                finalized_event = json.loads(await asyncio.wait_for(client.recv(), 1.5))
                assert timeout_event["type"] == "speech_ended"
                assert finalized_event["type"] == "utterance_finalized"

                await client.send(json.dumps({"type": "speech_ended"}))
                await client.send(json.dumps({"type": "stop"}))
                assert json.loads(await client.recv())["type"] == "recognition_stopped"

    asyncio.run(scenario())


def test_diagnostic_start_reports_runtime_profile() -> None:
    async def scenario() -> None:
        async with serve(
            lambda connection: handle_connection(
                connection,
                transcriber=RuntimeTranscriber(),
            ),
            "127.0.0.1",
            0,
        ) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/stream") as client:
                await client.send(
                    json.dumps(
                        {
                            "type": "start",
                            "language": "ja-JP",
                            "sampleRate": 16_000,
                            "channels": 1,
                            "format": "pcm_s16le",
                            "chunkMs": 200,
                            "diagnostics": True,
                        }
                    )
                )
                runtime = json.loads(await client.recv())
                listening = json.loads(await client.recv())
                assert runtime["type"] == "stt_runtime"
                assert runtime["runtime"]["effectiveDevice"] == "cpu"
                assert listening["type"] == "listening_started"
                await client.send(json.dumps({"type": "stop"}))
                assert json.loads(await client.recv())["type"] == "recognition_stopped"

    asyncio.run(scenario())
