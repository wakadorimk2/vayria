from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import wave
from collections.abc import Iterable


STT_ROOT = Path(__file__).resolve().parents[1]
if str(STT_ROOT) not in sys.path:
    sys.path.insert(0, str(STT_ROOT))

from vayria_stt.transcriber import (  # noqa: E402
    DEFAULT_BEAM_SIZE,
    DEFAULT_HOTWORDS,
    DEFAULT_TEMPERATURES,
    FasterWhisperTranscriber,
    STT_BEAM_SIZE_VALUES,
    STT_COMPUTE_TYPE_VALUES,
    STT_DEVICE_VALUES,
    STT_MODEL_VALUES,
)


DEFAULT_RESULT_PATH = Path(__file__).resolve().parent / "local" / "benchmark-result.json"
TEXT_WHITESPACE = re.compile(r"\s+")
TEXT_PUNCTUATION = "、。．.!！?？,"


def _normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = TEXT_WHITESPACE.sub("", normalized)
    return normalized.strip(TEXT_PUNCTUATION)


def _edit_distance(left: list[str], right: list[str]) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_value in enumerate(right, start=1):
            substitution = previous[right_index - 1] + (left_value != right_value)
            insertion = current[right_index - 1] + 1
            deletion = previous[right_index] + 1
            current.append(min(substitution, insertion, deletion))
        previous = current
    return previous[-1]


def _error_rate(reference: str, hypothesis: str, *, word_mode: bool = False) -> float:
    normalized_reference = _normalize_text(reference)
    normalized_hypothesis = _normalize_text(hypothesis)
    if word_mode:
        if " " in reference or " " in hypothesis:
            reference_units = TEXT_WHITESPACE.split(reference.strip()) if reference.strip() else []
            hypothesis_units = TEXT_WHITESPACE.split(hypothesis.strip()) if hypothesis.strip() else []
        else:
            reference_units = list(normalized_reference)
            hypothesis_units = list(normalized_hypothesis)
    else:
        reference_units = list(normalized_reference)
        hypothesis_units = list(normalized_hypothesis)
    if not reference_units:
        return 0.0 if not hypothesis_units else 1.0
    return _edit_distance(reference_units, hypothesis_units) / len(reference_units)


def _percentile(values: Iterable[float], fraction: float) -> float | None:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * weight, 3)


def _mean(values: Iterable[float]) -> float | None:
    collected = [float(value) for value in values]
    if not collected:
        return None
    return round(sum(collected) / len(collected), 3)


def _read_pcm16(path: Path) -> bytes:
    with wave.open(str(path), "rb") as audio_file:
        if (
            audio_file.getnchannels() != 1
            or audio_file.getsampwidth() != 2
            or audio_file.getframerate() != 16_000
        ):
            raise ValueError(
                f"{path} must be mono, 16-bit, 16 kHz PCM WAV"
            )
        return audio_file.readframes(audio_file.getnframes())


def _load_manifest(path: Path) -> list[dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = payload.get("cases") if isinstance(payload, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ValueError("manifest must contain a non-empty cases array")
    valid_cases: list[dict[str, object]] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise ValueError(f"manifest case {index} is not an object")
        if not isinstance(case.get("audio"), str):
            raise ValueError(f"manifest case {index} needs an audio path")
        if not isinstance(case.get("reference", ""), str):
            raise ValueError(f"manifest case {index} needs a string reference")
        valid_cases.append(case)
    return valid_cases


def _voice_lab_metrics(paths: list[Path]) -> dict[str, object]:
    fields = {
        "endpointToResultLatencyMs": [],
        "sttQueueWaitMs": [],
        "sttProcessingMs": [],
        "finalizedToConversationInputMs": [],
    }
    read_errors = 0
    for path in paths:
        with path.open("r", encoding="utf-8") as jsonl_file:
            for line in jsonl_file:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    read_errors += 1
                    continue
                if record.get("kind") != "utterance":
                    continue
                for field, values in fields.items():
                    value = record.get(field)
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        values.append(float(value))

    metrics: dict[str, object] = {
        "eouToResultMs": {
            "count": len(fields["endpointToResultLatencyMs"]),
            "p50": _percentile(fields["endpointToResultLatencyMs"], 0.50),
            "p95": _percentile(fields["endpointToResultLatencyMs"], 0.95),
        },
        "queueWaitMs": {
            "count": len(fields["sttQueueWaitMs"]),
            "p50": _percentile(fields["sttQueueWaitMs"], 0.50),
            "p95": _percentile(fields["sttQueueWaitMs"], 0.95),
        },
        "whisperProcessingMs": {
            "count": len(fields["sttProcessingMs"]),
            "p50": _percentile(fields["sttProcessingMs"], 0.50),
            "p95": _percentile(fields["sttProcessingMs"], 0.95),
        },
        "resultToConversationInputMs": {
            "count": len(fields["finalizedToConversationInputMs"]),
            "p50": _percentile(fields["finalizedToConversationInputMs"], 0.50),
            "p95": _percentile(fields["finalizedToConversationInputMs"], 0.95),
        },
        "files": [str(path) for path in paths],
        "readErrors": read_errors,
    }
    return metrics


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate local Vayria STT WAV cases and Voice Lab latency JSONL."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--audio-root", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_RESULT_PATH)
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model", choices=STT_MODEL_VALUES, default="small")
    parser.add_argument("--device", choices=STT_DEVICE_VALUES, default="cuda")
    parser.add_argument(
        "--compute-type",
        choices=STT_COMPUTE_TYPE_VALUES,
        default="float16",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        choices=STT_BEAM_SIZE_VALUES,
        default=DEFAULT_BEAM_SIZE,
    )
    parser.add_argument(
        "--temperatures",
        type=float,
        nargs="+",
        default=list(DEFAULT_TEMPERATURES),
    )
    parser.add_argument("--hotwords", default=DEFAULT_HOTWORDS)
    parser.add_argument("--require-primary-profile", action="store_true")
    parser.add_argument(
        "--voice-lab-jsonl",
        type=Path,
        action="append",
        default=[],
        help="Add a Voice Lab JSONL export for p50/p95 latency metrics.",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    manifest_path = args.manifest.resolve()
    cases = _load_manifest(manifest_path)
    audio_root = (args.audio_root or manifest_path.parent).resolve()
    transcriber = FasterWhisperTranscriber(
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        beam_size=args.beam_size,
        temperatures=tuple(args.temperatures),
        hotwords=args.hotwords,
        require_primary_profile=args.require_primary_profile,
    )
    runtime = transcriber.prepare()
    transcriber.warm_up(args.language)

    case_results: list[dict[str, object]] = []
    for case in cases:
        audio_path = Path(str(case["audio"]))
        if not audio_path.is_absolute():
            audio_path = audio_root / audio_path
        started = time.perf_counter()
        try:
            pcm = _read_pcm16(audio_path)
            result = transcriber.transcribe_pcm16_with_diagnostics(
                pcm,
                sample_rate=16_000,
                language=args.language,
            )
            elapsed_ms = round((time.perf_counter() - started) * 1_000, 3)
            hypothesis = result.text
            reference = str(case.get("reference", ""))
            terms = [
                str(term)
                for term in case.get("terms", [])
                if isinstance(term, str) and term
            ]
            normalized_hypothesis = _normalize_text(hypothesis)
            proper_noun_hits = sum(
                _normalize_text(term) in normalized_hypothesis for term in terms
            )
            expected_empty = bool(case.get("expectedEmpty", False))
            short_utterance = bool(case.get("shortUtterance", False))
            case_results.append(
                {
                    "id": str(case.get("id", audio_path.stem)),
                    "category": str(case.get("category", "unspecified")),
                    "reference": reference,
                    "hypothesis": hypothesis,
                    "filterReason": result.filter_reason,
                    "processingMs": elapsed_ms,
                    "cer": round(_error_rate(reference, hypothesis), 6),
                    "wer": round(_error_rate(reference, hypothesis, word_mode=True), 6),
                    "properNounHits": proper_noun_hits,
                    "properNounCount": len(terms),
                    "shortUtterance": short_utterance,
                    "shortExact": short_utterance
                    and _normalize_text(reference) == normalized_hypothesis,
                    "expectedEmpty": expected_empty,
                    "hallucination": expected_empty and bool(normalized_hypothesis),
                }
            )
        except Exception as error:
            case_results.append(
                {
                    "id": str(case.get("id", audio_path.stem)),
                    "category": str(case.get("category", "unspecified")),
                    "audio": str(audio_path),
                    "error": f"{error.__class__.__name__}: {error}",
                }
            )

    valid_results = [result for result in case_results if "error" not in result]
    cer_values = [float(result["cer"]) for result in valid_results]
    wer_values = [float(result["wer"]) for result in valid_results]
    proper_noun_hits = sum(int(result["properNounHits"]) for result in valid_results)
    proper_noun_count = sum(int(result["properNounCount"]) for result in valid_results)
    short_results = [result for result in valid_results if result["shortUtterance"]]
    empty_results = [result for result in valid_results if result["expectedEmpty"]]
    hallucinations = sum(bool(result["hallucination"]) for result in empty_results)
    processing_values = [float(result["processingMs"]) for result in valid_results]
    report: dict[str, object] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(manifest_path),
        "runtime": runtime,
        "metrics": {
            "caseCount": len(case_results),
            "completedCaseCount": len(valid_results),
            "errorCaseCount": len(case_results) - len(valid_results),
            "cer": _mean(cer_values),
            "wer": _mean(wer_values),
            "properNounRecall": (
                proper_noun_hits / proper_noun_count if proper_noun_count else None
            ),
            "shortUtteranceExactAccuracy": (
                sum(bool(result["shortExact"]) for result in short_results)
                / len(short_results)
                if short_results
                else None
            ),
            "hallucinationRate": (
                hallucinations / len(empty_results) if empty_results else None
            ),
            "offlineTranscribeMs": {
                "count": len(processing_values),
                "p50": _percentile(processing_values, 0.50),
                "p95": _percentile(processing_values, 0.95),
            },
        },
        "voiceLab": _voice_lab_metrics(
            [path.resolve() for path in args.voice_lab_jsonl]
        )
        if args.voice_lab_jsonl
        else None,
        "cases": case_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not report["metrics"]["errorCaseCount"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
