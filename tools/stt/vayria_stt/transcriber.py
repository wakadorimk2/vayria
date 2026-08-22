from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class Transcriber(Protocol):
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        """Transcribe an in-memory PCM16 utterance into text."""


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
                vad_filter=False,
            )
            return "".join(segment.text for segment in segments).strip()
        finally:
            del audio
