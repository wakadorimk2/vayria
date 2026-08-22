from __future__ import annotations

from dataclasses import dataclass

from vayria_stt.vad import FRAME_BYTES, PcmUtteranceDetector


@dataclass
class SequenceClassifier:
    values: list[bool]

    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        assert len(frame) == FRAME_BYTES
        assert sample_rate == 16_000
        return self.values.pop(0)


def frame(value: int) -> bytes:
    return bytes([value]) * FRAME_BYTES


def test_speech_started_after_two_consecutive_speech_frames() -> None:
    classifier = SequenceClassifier([True, True, False])
    detector = PcmUtteranceDetector(
        classifier=classifier,
        end_silence_frame_count=1,
    )

    events = detector.feed(frame(1) + frame(2))

    assert [event.type for event in events] == ["speech_started"]
    assert events[0].segment_id


def test_six_hundred_ms_silence_finalizes_once() -> None:
    classifier = SequenceClassifier([True, True] + [False] * 30)
    detector = PcmUtteranceDetector(classifier=classifier)

    events = detector.feed(b"".join(frame(index) for index in range(32)))

    assert [event.type for event in events] == [
        "speech_started",
        "speech_ended",
        "utterance_finalized",
    ]
    assert events[-1].audio == frame(0) + frame(1)
    assert detector.flush() == []
