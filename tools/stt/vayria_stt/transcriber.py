from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import re
from time import perf_counter
import unicodedata
from collections.abc import Iterable
from typing import Protocol


NO_SPEECH_THRESHOLD = 0.6
LOG_PROB_THRESHOLD = -1.0
COMPRESSION_RATIO_THRESHOLD = 2.4
HALLUCINATION_ONLY_PHRASES = frozenset({"ご視聴ありがとうございました"})
TRANSCRIPT_STRIP_CHARACTERS = " \t\r\n\u3000。、．.!！?？…"
WARM_UP_AUDIO_SAMPLES = 320
STT_MODEL_VALUES = ("tiny", "base", "small")
STT_DEVICE_VALUES = ("auto", "cuda", "cpu")
STT_COMPUTE_TYPE_VALUES = ("auto", "float16", "int8", "int8_float16")
STT_BEAM_SIZE_VALUES = (1, 3)
DEFAULT_HOTWORDS = "Vayria GPT-Live Codex"
DEFAULT_BEAM_SIZE = 3
DEFAULT_TEMPERATURES = (0.0, 0.2)
DEFAULT_WITHOUT_TIMESTAMPS = True
DEFAULT_CONDITION_ON_PREVIOUS_TEXT = False
DEFAULT_VAD_FILTER = False


class Transcriber(Protocol):
    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        """Transcribe an in-memory PCM16 utterance into text."""


@dataclass(frozen=True)
class TranscriptionResult:
    raw_text: str
    text: str
    filter_reason: str | None


@dataclass(frozen=True)
class SttRuntimeInfo:
    requestedModel: str
    requestedDevice: str
    requestedComputeType: str
    effectiveModel: str
    effectiveDevice: str
    effectiveComputeType: str
    fallbackUsed: bool
    fallbackReason: str | None
    modelLoadMs: int | None
    decodeBeamSize: int
    decodeTemperatures: tuple[float, ...]
    decodeWithoutTimestamps: bool
    decodeConditionOnPreviousText: bool
    decodeVadFilter: bool
    hotwords: str | None
    primaryProfileRequired: bool


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


def _raw_transcription_segments(segments: Iterable[object]) -> str:
    return "".join(
        str(getattr(segment, "text", ""))
        for segment in segments
        if _is_confident_segment(segment)
    ).strip()


def _filter_transcription_segments(segments: Iterable[object]) -> str:
    accepted_text = _raw_transcription_segments(segments)
    if not accepted_text:
        return ""

    normalized = _normalized_for_hallucination_check(accepted_text)
    if normalized in HALLUCINATION_ONLY_PHRASES:
        return ""
    return accepted_text


@dataclass
class FasterWhisperTranscriber:
    model_name: str = "small"
    device: str = "auto"
    compute_type: str = "auto"
    fallback_model: str = "tiny"
    fallback_device: str = "cpu"
    fallback_compute_type: str = "int8"
    beam_size: int = DEFAULT_BEAM_SIZE
    temperatures: tuple[float, ...] = DEFAULT_TEMPERATURES
    without_timestamps: bool = DEFAULT_WITHOUT_TIMESTAMPS
    condition_on_previous_text: bool = DEFAULT_CONDITION_ON_PREVIOUS_TEXT
    vad_filter: bool = DEFAULT_VAD_FILTER
    hotwords: str | None = DEFAULT_HOTWORDS
    require_primary_profile: bool = False

    def __post_init__(self) -> None:
        self._model = None
        self._prepared = False
        self._effective_model = self.model_name
        self._effective_device, self._effective_compute_type = (
            self._resolve_device_and_compute_type(self.device, self.compute_type)
        )
        self._fallback_used = False
        self._fallback_reason: str | None = None
        self._model_load_ms: int | None = None

        if self.beam_size not in STT_BEAM_SIZE_VALUES:
            raise ValueError(f"unsupported STT beam size: {self.beam_size}")
        try:
            self.temperatures = tuple(float(value) for value in self.temperatures)
        except (TypeError, ValueError) as error:
            raise ValueError("STT temperatures must be numeric") from error
        if not self.temperatures or any(
            not math.isfinite(value) or value < 0 for value in self.temperatures
        ):
            raise ValueError("STT temperatures must be finite and non-negative")
        if self.hotwords is not None:
            self.hotwords = self.hotwords.strip() or None

        if self.model_name not in STT_MODEL_VALUES:
            raise ValueError(f"unsupported STT model: {self.model_name}")
        if self.device not in STT_DEVICE_VALUES:
            raise ValueError(f"unsupported STT device: {self.device}")
        if self.compute_type not in STT_COMPUTE_TYPE_VALUES:
            raise ValueError(f"unsupported STT compute type: {self.compute_type}")
        if self.fallback_model not in STT_MODEL_VALUES:
            raise ValueError(f"unsupported STT fallback model: {self.fallback_model}")
        if self.fallback_device not in ("cuda", "cpu"):
            raise ValueError(f"unsupported STT fallback device: {self.fallback_device}")
        if self.fallback_compute_type not in STT_COMPUTE_TYPE_VALUES:
            raise ValueError(
                f"unsupported STT fallback compute type: {self.fallback_compute_type}"
            )

    @staticmethod
    def _resolve_device_and_compute_type(
        device: str,
        compute_type: str,
    ) -> tuple[str, str]:
        effective_device = "cuda" if device == "auto" else device
        if compute_type != "auto":
            return effective_device, compute_type
        return effective_device, "float16" if effective_device == "cuda" else "int8"

    def _load_model(self, model_name: str, device: str, compute_type: str):
        from faster_whisper import WhisperModel

        model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
        )
        return model, device, compute_type

    def prepare(self) -> dict[str, object]:
        """Load the selected model once and record the actual loaded profile."""
        if self._prepared and self._model is not None:
            return self.runtime_info()

        started = perf_counter()
        try:
            primary_device, primary_compute_type = (
                self._resolve_device_and_compute_type(self.device, self.compute_type)
            )
            model, device, compute_type = self._load_model(
                self.model_name,
                primary_device,
                primary_compute_type,
            )
            self._model = model
            self._effective_model = self.model_name
            self._effective_device = device
            self._effective_compute_type = compute_type
            self._fallback_used = False
            self._fallback_reason = None
        except Exception as primary_error:
            self._model = None
            self._model_load_ms = max(0, round((perf_counter() - started) * 1_000))
            if self.require_primary_profile:
                self._fallback_used = False
                self._fallback_reason = None
                raise RuntimeError(
                    "STT primary profile load failed and fallback is disabled: "
                    f"{primary_error}"
                ) from primary_error
            self._fallback_used = True
            self._fallback_reason = (
                str(primary_error) or primary_error.__class__.__name__
            )[:500]
            try:
                fallback_device, fallback_compute_type = (
                    self._resolve_device_and_compute_type(
                        self.fallback_device,
                        self.fallback_compute_type,
                    )
                )
                model, device, compute_type = self._load_model(
                    self.fallback_model,
                    fallback_device,
                    fallback_compute_type,
                )
            except Exception as fallback_error:
                self._model = None
                self._model_load_ms = max(0, round((perf_counter() - started) * 1_000))
                raise RuntimeError(
                    "STT model load failed for primary and fallback profiles: "
                    f"primary={primary_error}; fallback={fallback_error}"
                ) from fallback_error
            self._model = model
            self._effective_model = self.fallback_model
            self._effective_device = device
            self._effective_compute_type = compute_type

        self._model_load_ms = max(0, round((perf_counter() - started) * 1_000))
        self._prepared = True
        return self.runtime_info()

    def warm_up(self, language: str = "ja") -> None:
        """Run one short inference so the first user utterance avoids model setup."""
        model = self._get_model()
        import numpy as np

        audio = np.zeros(WARM_UP_AUDIO_SAMPLES, dtype=np.float32)
        try:
            segments, _info = model.transcribe(
                audio,
                language=language,
                beam_size=self.beam_size,
                temperature=self.temperatures,
                compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
                log_prob_threshold=LOG_PROB_THRESHOLD,
                no_speech_threshold=NO_SPEECH_THRESHOLD,
                condition_on_previous_text=self.condition_on_previous_text,
                vad_filter=self.vad_filter,
                without_timestamps=self.without_timestamps,
                hotwords=self.hotwords,
            )
            next(iter(segments), None)
        finally:
            del audio

    def runtime_info(self) -> dict[str, object]:
        return asdict(
            SttRuntimeInfo(
                requestedModel=self.model_name,
                requestedDevice=self.device,
                requestedComputeType=self.compute_type,
                effectiveModel=self._effective_model,
                effectiveDevice=self._effective_device,
                effectiveComputeType=self._effective_compute_type,
                fallbackUsed=self._fallback_used,
                fallbackReason=self._fallback_reason,
                modelLoadMs=self._model_load_ms,
                decodeBeamSize=self.beam_size,
                decodeTemperatures=self.temperatures,
                decodeWithoutTimestamps=self.without_timestamps,
                decodeConditionOnPreviousText=self.condition_on_previous_text,
                decodeVadFilter=self.vad_filter,
                hotwords=self.hotwords,
                primaryProfileRequired=self.require_primary_profile,
            )
        )

    def _get_model(self):
        if self._model is None:
            self.prepare()
        return self._model

    def transcribe_pcm16_with_diagnostics(
        self,
        pcm: bytes,
        *,
        sample_rate: int,
        language: str,
    ) -> TranscriptionResult:
        if not pcm:
            return TranscriptionResult('', '', 'empty-audio')

        import numpy as np

        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32_768.0
        try:
            segments, _info = self._get_model().transcribe(
                audio,
                language=language,
                beam_size=self.beam_size,
                temperature=self.temperatures,
                compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
                log_prob_threshold=LOG_PROB_THRESHOLD,
                no_speech_threshold=NO_SPEECH_THRESHOLD,
                condition_on_previous_text=self.condition_on_previous_text,
                vad_filter=self.vad_filter,
                without_timestamps=self.without_timestamps,
                hotwords=self.hotwords,
            )
            raw_text = _raw_transcription_segments(segments)
            if not raw_text:
                return TranscriptionResult('', '', 'empty-or-low-confidence')

            normalized = _normalized_for_hallucination_check(raw_text)
            if normalized in HALLUCINATION_ONLY_PHRASES:
                return TranscriptionResult(
                    raw_text,
                    '',
                    'known-hallucination',
                )
            return TranscriptionResult(raw_text, raw_text, None)
        finally:
            del audio

    def transcribe_pcm16(self, pcm: bytes, *, sample_rate: int, language: str) -> str:
        return self.transcribe_pcm16_with_diagnostics(
            pcm,
            sample_rate=sample_rate,
            language=language,
        ).text
