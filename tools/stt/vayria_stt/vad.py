from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import uuid4

import webrtcvad

SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
FRAME_DURATION_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_DURATION_MS // 1_000 * SAMPLE_WIDTH_BYTES
START_SPEECH_FRAME_COUNT = 2
END_SILENCE_FRAME_COUNT = 30
MAX_UTTERANCE_FRAME_COUNT = 1_500


class SpeechClassifier(Protocol):
    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        """Return whether one complete PCM16 frame contains speech."""


class WebRtcSpeechClassifier:
    def __init__(self, mode: int = 2) -> None:
        self._vad = webrtcvad.Vad(mode)

    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        return self._vad.is_speech(frame, sample_rate)


EventType = Literal["speech_started", "speech_ended", "utterance_finalized"]


@dataclass(frozen=True)
class DetectorEvent:
    type: EventType
    segment_id: str
    audio: bytes | None = None


class PcmUtteranceDetector:
    """Convert arbitrary PCM chunks into VAD-backed utterance events.

    The detector stores only the current utterance in memory. It does not
    write PCM data to disk and it does not include audio in diagnostics.
    """

    def __init__(
        self,
        classifier: SpeechClassifier | None = None,
        *,
        frame_bytes: int = FRAME_BYTES,
        start_speech_frame_count: int = START_SPEECH_FRAME_COUNT,
        end_silence_frame_count: int = END_SILENCE_FRAME_COUNT,
        max_utterance_frame_count: int = MAX_UTTERANCE_FRAME_COUNT,
    ) -> None:
        self._classifier = classifier or WebRtcSpeechClassifier()
        self._frame_bytes = frame_bytes
        self._start_speech_frame_count = start_speech_frame_count
        self._end_silence_frame_count = end_silence_frame_count
        self._max_utterance_frame_count = max_utterance_frame_count
        self._pending = bytearray()
        self._candidate_frames: list[bytes] = []
        self._speech_streak = 0
        self._silence_streak = 0
        self._active_segment_id: str | None = None
        self._active_audio = bytearray()
        self._trailing_silence: list[bytes] = []
        self._active_frame_count = 0

    def feed(self, pcm: bytes) -> list[DetectorEvent]:
        if not pcm:
            return []
        self._pending.extend(pcm)
        events: list[DetectorEvent] = []
        while len(self._pending) >= self._frame_bytes:
            frame = bytes(self._pending[: self._frame_bytes])
            del self._pending[: self._frame_bytes]
            events.extend(self._process_frame(frame))
        return events

    def flush(self) -> list[DetectorEvent]:
        if self._active_segment_id is None:
            self.reset()
            return []
        events = self._finish_active_segment()
        self.reset()
        return events

    def reset(self) -> None:
        self._pending.clear()
        self._reset_segment_state()

    def _reset_segment_state(self) -> None:
        self._candidate_frames.clear()
        self._speech_streak = 0
        self._silence_streak = 0
        self._active_segment_id = None
        self._active_audio.clear()
        self._trailing_silence.clear()
        self._active_frame_count = 0

    def _process_frame(self, frame: bytes) -> list[DetectorEvent]:
        is_speech = self._classifier.is_speech(frame, SAMPLE_RATE)
        if self._active_segment_id is None:
            return self._process_inactive_frame(frame, is_speech)
        return self._process_active_frame(frame, is_speech)

    def _process_inactive_frame(self, frame: bytes, is_speech: bool) -> list[DetectorEvent]:
        if not is_speech:
            self._speech_streak = 0
            self._candidate_frames.clear()
            return []

        self._speech_streak += 1
        self._candidate_frames.append(frame)
        if self._speech_streak < self._start_speech_frame_count:
            return []

        segment_id = f"voice-segment-{uuid4().hex}"
        self._active_segment_id = segment_id
        self._active_audio.extend(b"".join(self._candidate_frames))
        self._active_frame_count = len(self._candidate_frames)
        self._candidate_frames.clear()
        self._speech_streak = 0
        return [DetectorEvent("speech_started", segment_id)]

    def _process_active_frame(self, frame: bytes, is_speech: bool) -> list[DetectorEvent]:
        segment_id = self._active_segment_id
        if segment_id is None:
            return []

        if is_speech:
            if self._trailing_silence:
                self._active_audio.extend(b"".join(self._trailing_silence))
                self._trailing_silence.clear()
            self._active_audio.extend(frame)
            self._active_frame_count += 1
            self._silence_streak = 0
            if self._active_frame_count >= self._max_utterance_frame_count:
                events = self._finish_active_segment()
                self._reset_segment_state()
                return events
            return []

        self._trailing_silence.append(frame)
        self._silence_streak += 1
        if self._silence_streak < self._end_silence_frame_count:
            return []
        events = self._finish_active_segment()
        self._reset_segment_state()
        return events

    def _finish_active_segment(self) -> list[DetectorEvent]:
        segment_id = self._active_segment_id
        if segment_id is None:
            return []
        audio = bytes(self._active_audio)
        return [
            DetectorEvent("speech_ended", segment_id),
            DetectorEvent("utterance_finalized", segment_id, audio),
        ]
