from __future__ import annotations

import asyncio
import json

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from vayria_stt.server import handle_connection


class FakeTranscriber:
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        return "テスト"


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
