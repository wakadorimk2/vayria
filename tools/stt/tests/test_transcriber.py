from __future__ import annotations

from vayria_stt.transcriber import Transcriber


class FakeTranscriber:
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        return f"{len(pcm)}:{sample_rate}:{language}"


def test_transcriber_contract_is_provider_agnostic() -> None:
    provider: Transcriber = FakeTranscriber()
    assert provider.transcribe_pcm16(
        b"\x00" * 640,
        sample_rate=16_000,
        language="ja",
    ) == "640:16000:ja"
