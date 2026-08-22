from __future__ import annotations

from dataclasses import dataclass

from vayria_stt.transcriber import (
    FasterWhisperTranscriber,
    Transcriber,
    TranscriptionResult,
)


class FakeTranscriber:
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        return f"{len(pcm)}:{sample_rate}:{language}"


@dataclass(frozen=True)
class FakeSegment:
    text: str
    no_speech_prob: float = 0.1
    avg_logprob: float = -0.2
    compression_ratio: float = 1.1


class FakeWhisperModel:
    def __init__(self, segments: list[FakeSegment]) -> None:
        self.segments = segments
        self.options: dict[str, object] = {}

    def transcribe(self, audio, **options):
        assert len(audio) > 0
        self.options = options
        return iter(self.segments), None


def test_transcriber_contract_is_provider_agnostic() -> None:
    provider: Transcriber = FakeTranscriber()
    assert provider.transcribe_pcm16(
        b"\x00" * 640,
        sample_rate=16_000,
        language="ja",
    ) == "640:16000:ja"


def transcribe_with_segments(segments: list[FakeSegment]) -> tuple[str, FakeWhisperModel]:
    provider = FasterWhisperTranscriber()
    model = FakeWhisperModel(segments)
    provider._model = model
    return provider.transcribe_pcm16(
        b"\x00\x01" * 320,
        sample_rate=16_000,
        language="ja",
    ), model


def test_faster_whisper_receives_explicit_hallucination_guards() -> None:
    _text, model = transcribe_with_segments([FakeSegment("こんにちは")])

    assert model.options == {
        "language": "ja",
        "beam_size": 1,
        "temperature": 0.0,
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
        "condition_on_previous_text": False,
        "vad_filter": False,
    }


def test_low_confidence_segments_are_discarded() -> None:
    text, _model = transcribe_with_segments(
        [
            FakeSegment("無音由来", no_speech_prob=0.8),
            FakeSegment("低信頼", avg_logprob=-1.1),
            FakeSegment("反復由来", compression_ratio=2.5),
            FakeSegment("通常の発話"),
        ]
    )

    assert text == "通常の発話"


def test_standalone_viewing_thanks_hallucination_is_discarded() -> None:
    text, _model = transcribe_with_segments(
        [FakeSegment(" ご視聴ありがとうございました。 ")]
    )

    assert text == ""


def test_diagnostics_preserve_raw_text_and_filtered_text() -> None:
    provider = FasterWhisperTranscriber()
    provider._model = FakeWhisperModel(
        [FakeSegment(" ご視聴ありがとうございました。 ")]
    )

    result = provider.transcribe_pcm16_with_diagnostics(
        b"\x00\x01" * 320,
        sample_rate=16_000,
        language="ja",
    )

    assert isinstance(result, TranscriptionResult)
    assert result.raw_text == "ご視聴ありがとうございました。"
    assert result.text == ""
    assert result.filter_reason == "known-hallucination"


def test_normal_speech_is_preserved() -> None:
    text, _model = transcribe_with_segments(
        [FakeSegment("ご視聴ありがとうございましたと言いました")]
    )

    assert text == "ご視聴ありがとうございましたと言いました"
