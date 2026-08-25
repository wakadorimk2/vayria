from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import uuid
import wave

from .transcriber import TranscriptionResult


SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
MAX_CAPTURE_SEGMENTS = 10
DEFAULT_CAPTURE_DIR = (
    Path(__file__).resolve().parents[3]
    / "tools"
    / "stt"
    / "benchmarks"
    / "local"
    / "capture"
)


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class SttCaptureWriter:
    """Persist explicit, local-only STT utterance captures for comparison."""

    def __init__(
        self,
        root: Path = DEFAULT_CAPTURE_DIR,
        *,
        max_segments: int = MAX_CAPTURE_SEGMENTS,
    ) -> None:
        if max_segments < 1:
            raise ValueError("max_segments must be positive")
        self.root = Path(root)
        self.max_segments = max_segments
        session_name = (
            f"session-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-"
            f"{uuid.uuid4().hex[:8]}"
        )
        self.session_dir = self.root / session_name
        self.session_dir.mkdir(parents=True, exist_ok=False)
        self.index_path = self.session_dir / "index.jsonl"
        self.manifest_path = self.session_dir / "manifest.draft.json"
        self._count = 0
        self._manifest_cases: list[dict[str, object]] = []
        self._write_manifest()

    @property
    def count(self) -> int:
        return self._count

    def write(
        self,
        segment_id: str,
        pcm: bytes,
        result: TranscriptionResult,
    ) -> Path | None:
        if self._count >= self.max_segments:
            return None
        if len(pcm) == 0 or len(pcm) % SAMPLE_WIDTH_BYTES != 0:
            raise ValueError("capture PCM must contain complete 16-bit samples")

        self._count += 1
        capture_id = f"segment-{self._count:04d}"
        audio_name = f"{capture_id}.wav"
        audio_path = self.session_dir / audio_name
        with wave.open(str(audio_path), "wb") as audio_file:
            audio_file.setnchannels(CHANNELS)
            audio_file.setsampwidth(SAMPLE_WIDTH_BYTES)
            audio_file.setframerate(SAMPLE_RATE)
            audio_file.writeframes(pcm)

        record = {
            "id": capture_id,
            "segmentId": segment_id,
            "audio": audio_name,
            "capturedAt": _utc_timestamp(),
            "durationMs": round(
                len(pcm) / SAMPLE_WIDTH_BYTES / SAMPLE_RATE * 1_000,
                3,
            ),
            "rawText": result.raw_text,
            "acceptedText": result.text,
            "filterReason": result.filter_reason,
        }
        with self.index_path.open("a", encoding="utf-8") as index_file:
            index_file.write(json.dumps(record, ensure_ascii=False) + "\n")

        self._manifest_cases.append(
            {
                "id": capture_id,
                "category": "uncategorized",
                "audio": audio_name,
                "reference": "",
            }
        )
        self._write_manifest()
        return audio_path

    def _write_manifest(self) -> None:
        payload = {
            "description": (
                "Draft manifest generated from explicit STT captures. "
                "Fill reference and category before benchmark evaluation."
            ),
            "cases": self._manifest_cases,
        }
        self.manifest_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
