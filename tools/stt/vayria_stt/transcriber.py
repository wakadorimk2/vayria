from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from collections.abc import Iterable
from typing import Protocol


NO_SPEECH_THRESHOLD = 0.6
LOG_PROB_THRESHOLD = -1.0
COMPRESSION_RATIO_THRESHOLD = 2.4
HALLUCINATION_ONLY_PHRASES = frozenset({"ご視聴ありがとうございました"})
TRANSCRIPT_STRIP_CHARACTERS = " \t\r\n\u3000。、．.!！?？…"


class Transcriber(Protocol):
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        """Transcribe an in-memory PCM16 utterance into text."""


def _normalized_for_hallucination_check(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", "", normalized)
    return normalized.strip(TRANSCRIPT_STRIP_CHARACTERS)


def _is_confident_segment(segment: object) -> bool:
    try:
        no_speech_prob = float(getattr(segment, "no_speech_prob"))
        avg_logprob = float(getattr(segment, "avg_logprob"))
        compression_ratio = float(getattr(segment, "compression_ratio"))
    except (AttributeError, TypeError, ValueError):
        return False

    return (
        no_speech_prob < NO_SPEECH_THRESHOLD
        and avg_logprob >= LOG_PROB_THRESHOLD
        and compression_ratio <= COMPRESSION_RATIO_THRESHOLD
    )


def _filter_transcription_segments(segments: Iterable[object]) -> str:
    accepted_text = "".join(
        str(getattr(segment, "text", ""))
        for segment in segments
        if _is_confident_segment(segment)
    ).strip()
    if not accepted_text:
        return ""

    normalized = _normalized_for_hallucination_check(accepted_text)
    if normalized in HALLUCINATION_ONLY_PHRASES:
        return ""
    return accepted_text


@dataclass
class FasterWhisperTranscriber:
    model_name: str = "small"
    device: str = "cpu"
    compute_type: str = "int8"

    def __post_init__(self) -> None:
        self._model = None

    def _get_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        return self._model

    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        if not pcm:
            return ""

        import numpy as np

        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32_768.0
        try:
            segments, _info = self._get_model().transcribe(
                audio,
                language=language,
                beam_size=1,
                temperature=0.0,
                compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
                log_prob_threshold=LOG_PROB_THRESHOLD,
                no_speech_threshold=NO_SPEECH_THRESHOLD,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            return _filter_transcription_segments(segments)
        finally:
            del audio
