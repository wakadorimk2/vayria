from __future__ import annotations

import asyncio
import json
from contextlib import suppress

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from vayria_stt.server import (
    SUPPORTED_CHUNK_MS,
    SUPPORTED_FORMAT,
    _parse_start,
    _transcription_worker,
    handle_connection,
)
from vayria_stt.transcriber import TranscriptionResult


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


class FakeConnection:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send(self, message: str) -> None:
        self.messages.append(message)


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


def test_diagnostic_worker_emits_raw_and_filtered_transcript() -> None:
    async def scenario() -> None:
        connection = FakeConnection()
        queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()
        await queue.put(("segment-1", b"\x00" * 6_400))
        worker = asyncio.create_task(
            _transcription_worker(
                connection,
                queue,
                DiagnosticTranscriber(),
                "ja",
                True,
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
