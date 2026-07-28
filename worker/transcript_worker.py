#!/usr/bin/env python3
"""Owner-operated transcript worker.

It polls the public registry for jobs, prefers creator captions, falls back to
automatic captions, and uses local MLX Whisper or whisper.cpp only when needed.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_local_environment(path: Path) -> None:
    """Load a small KEY=VALUE file without executing shell code."""
    if not path.exists():
        return
    for raw_line in path.read_text("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            os.environ.setdefault(key, value.strip().strip("\"'"))


load_local_environment(PROJECT_ROOT / ".env.worker")

REGISTRY_URL = os.environ.get("REGISTRY_URL", "").rstrip("/")
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
LOCAL_YT_DLP = PROJECT_ROOT / ".venv" / "bin" / "yt-dlp"
YT_DLP_BINARY = os.environ.get(
    "YT_DLP_BINARY", str(LOCAL_YT_DLP) if LOCAL_YT_DLP.exists() else "yt-dlp"
)
MLX_MODEL = os.environ.get("MLX_WHISPER_MODEL", "mlx-community/whisper-small-mlx")
LOCAL_CPP_MODEL = PROJECT_ROOT / ".models" / "ggml-tiny.en.bin"
WHISPER_CPP_BINARY = os.environ.get(
    "WHISPER_CPP_BINARY", shutil.which("whisper-cli") or ""
)
WHISPER_CPP_MODEL = os.environ.get(
    "WHISPER_CPP_MODEL", str(LOCAL_CPP_MODEL) if LOCAL_CPP_MODEL.exists() else ""
)
ASR_ENGINE = os.environ.get(
    "ASR_ENGINE",
    "whisper-cpp" if WHISPER_CPP_BINARY and WHISPER_CPP_MODEL else "mlx",
)
AUDIO_FALLBACK_MODE = os.environ.get(
    "ALLOW_AUDIO_FALLBACK", "permissioned"
).strip().lower()
PERMISSIONED_CHANNEL_IDS = {
    value.strip()
    for value in os.environ.get("PERMISSIONED_CHANNEL_IDS", "").split(",")
    if value.strip()
}
POLL_SECONDS = max(3, int(os.environ.get("POLL_SECONDS", "15")))
WORKER_ID = os.environ.get(
    "WORKER_ID", f"{socket.gethostname()}-{os.getpid()}"
)

TIMESTAMP = re.compile(
    r"(?P<start>\d{2}:\d{2}(?::\d{2})?[\.,]\d{3})\s+-->\s+"
    r"(?P<end>\d{2}:\d{2}(?::\d{2})?[\.,]\d{3})"
)
TAG = re.compile(r"<[^>]+>")
TOPIC_WORD = re.compile(r"[a-z][a-z0-9-]{3,}")
TOPIC_STOP = {
    "about",
    "after",
    "also",
    "because",
    "before",
    "being",
    "from",
    "have",
    "into",
    "more",
    "that",
    "their",
    "there",
    "these",
    "this",
    "through",
    "video",
    "what",
    "when",
    "where",
    "which",
    "with",
    "your",
}


def request_json(
    path: str, payload: dict[str, Any], timeout: int = 120
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{REGISTRY_URL}{path}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {WORKER_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "transcript-registry-worker/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"Registry returned HTTP {error.code}: {detail}") from error


def run(command: list[str], cwd: Path, timeout: int = 3600) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(detail[-2000:] or f"Command failed: {command[0]}")
    return completed.stdout


def metadata(url: str, cwd: Path) -> dict[str, Any]:
    output = run(
        [
            YT_DLP_BINARY,
            "--dump-single-json",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            url,
        ],
        cwd,
        timeout=300,
    )
    return json.loads(output)


def fetch_captions(
    url: str, cwd: Path
) -> tuple[list[dict[str, Any]], str] | None:
    for source, option, stem in (
        ("creator-captions", "--write-subs", "creator"),
        ("automatic-captions", "--write-auto-subs", "automatic"),
    ):
        try:
            run(
                [
                    YT_DLP_BINARY,
                    "--skip-download",
                    option,
                    "--sub-langs",
                    "en.*,en",
                    "--sub-format",
                    "vtt",
                    "--no-playlist",
                    "--no-warnings",
                    "-o",
                    f"{stem}.%(ext)s",
                    url,
                ],
                cwd,
                timeout=300,
            )
        except RuntimeError:
            continue
        candidates = sorted(cwd.glob(f"{stem}*.vtt"))
        for candidate in candidates:
            segments = parse_vtt(candidate.read_text("utf-8", errors="replace"))
            if segments:
                return segments, source
    return None


def parse_vtt(content: str) -> list[dict[str, Any]]:
    blocks = re.split(r"\n\s*\n", content.replace("\r\n", "\n"))
    segments: list[dict[str, Any]] = []
    previous = ""
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing_index = next(
            (index for index, line in enumerate(lines) if TIMESTAMP.search(line)),
            None,
        )
        if timing_index is None:
            continue
        match = TIMESTAMP.search(lines[timing_index])
        if not match:
            continue
        text = " ".join(lines[timing_index + 1 :])
        text = html.unescape(TAG.sub("", text))
        text = re.sub(r"\s+", " ", text).strip()
        text = remove_rolling_overlap(previous, text)
        if not text:
            continue
        segments.append(
            {
                "start": parse_timestamp(match.group("start")),
                "end": parse_timestamp(match.group("end")),
                "text": text,
            }
        )
        previous = f"{previous} {text}".strip()[-500:]
    return segments


def remove_rolling_overlap(previous: str, current: str) -> str:
    if not current:
        return ""
    if current == previous or previous.endswith(current):
        return ""
    previous_words = previous.split()
    current_words = current.split()
    maximum = min(len(previous_words), len(current_words), 30)
    for size in range(maximum, 1, -1):
        if previous_words[-size:] == current_words[:size]:
            return " ".join(current_words[size:]).strip()
    return current


def parse_timestamp(value: str) -> float:
    fields = value.replace(",", ".").split(":")
    if len(fields) == 2:
        minutes, seconds = fields
        return int(minutes) * 60 + float(seconds)
    hours, minutes, seconds = fields
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def audio_fallback_allowed(info: dict[str, Any]) -> bool:
    if AUDIO_FALLBACK_MODE in {"1", "true", "yes", "all"}:
        return True
    if AUDIO_FALLBACK_MODE not in {"permissioned", "licensed", "cc"}:
        return False
    license_name = str(info.get("license") or "").lower()
    channel_id = str(info.get("channel_id") or "")
    return (
        "creative commons" in license_name
        or "cc by" in license_name
        or channel_id in PERMISSIONED_CHANNEL_IDS
    )


def transcribe_audio(
    url: str, cwd: Path, info: dict[str, Any]
) -> tuple[list[dict[str, Any]], str]:
    if not audio_fallback_allowed(info):
        raise RuntimeError(
            "No captions found. Local ASR is limited to Creative Commons or "
            "explicitly permissioned channels."
        )
    run(
        [
            YT_DLP_BINARY,
            "--no-playlist",
            "--no-warnings",
            "-x",
            "--audio-format",
            "wav",
            "--audio-quality",
            "5",
            "-o",
            "audio.%(ext)s",
            url,
        ],
        cwd,
        timeout=1800,
    )
    audio = next(cwd.glob("audio*.wav"), None)
    if not audio:
        raise RuntimeError("Audio download completed without a WAV file")

    if (
        ASR_ENGINE in {"mlx", "auto"}
        and platform.system() == "Darwin"
        and platform.machine() == "arm64"
    ):
        try:
            import mlx_whisper  # type: ignore

            result = mlx_whisper.transcribe(
                str(audio),
                path_or_hf_repo=MLX_MODEL,
                word_timestamps=True,
            )
            segments = [
                {
                    "start": float(segment.get("start", 0)),
                    "end": float(segment.get("end", 0)),
                    "text": str(segment.get("text", "")).strip(),
                }
                for segment in result.get("segments", [])
                if str(segment.get("text", "")).strip()
            ]
            if segments:
                return segments, "local-asr"
        except ImportError:
            pass

    if ASR_ENGINE in {"whisper-cpp", "auto"} and WHISPER_CPP_BINARY and WHISPER_CPP_MODEL:
        output = cwd / "whisper"
        run(
            [
                WHISPER_CPP_BINARY,
                "-m",
                WHISPER_CPP_MODEL,
                "-f",
                str(audio),
                "-ojf",
                "-of",
                str(output),
            ],
            cwd,
            timeout=3600,
        )
        result = json.loads((cwd / "whisper.json").read_text("utf-8"))
        segments = parse_whisper_cpp(result)
        if segments:
            return segments, "local-asr"

    raise RuntimeError(
        "Install mlx-whisper on Apple Silicon or configure whisper.cpp."
    )


def parse_whisper_cpp(result: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for item in result.get("transcription", []):
        timestamps = item.get("timestamps", {})
        start = timestamps.get("from", 0)
        end = timestamps.get("to")
        if isinstance(start, str):
            start = parse_timestamp(start)
        if isinstance(end, str):
            end = parse_timestamp(end)
        text = str(item.get("text", "")).strip()
        if text:
            segments.append({"start": float(start), "end": end, "text": text})
    return segments


def build_transcript(
    job: dict[str, Any], info: dict[str, Any], segments: list[dict[str, Any]], source: str
) -> dict[str, Any]:
    text = " ".join(segment["text"] for segment in segments)
    upload_date = str(info.get("upload_date") or "")
    published = (
        f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"
        if len(upload_date) == 8
        else None
    )
    channel = str(info.get("channel") or info.get("uploader") or "")
    description = str(info.get("description") or "")
    return {
        "provider": "youtube",
        "providerId": job["providerId"],
        "sourceUrl": job["sourceUrl"],
        "title": str(info.get("title") or job["providerId"]),
        "channel": channel,
        "channelUrl": info.get("channel_url") or info.get("uploader_url"),
        "description": description,
        "publishedAt": published,
        "durationSeconds": info.get("duration"),
        "language": str(info.get("language") or "en"),
        "transcriptSource": source,
        "license": str(info.get("license") or "unknown"),
        "attribution": f"{channel} — original source linked above.",
        "topics": extract_topics(f"{info.get('title', '')} {description}"),
        "transcriptText": text,
        "segments": segments,
    }


def extract_topics(value: str) -> list[str]:
    counts: dict[str, int] = {}
    for word in TOPIC_WORD.findall(value.lower()):
        if word in TOPIC_STOP:
            continue
        counts[word] = counts.get(word, 0) + 1
    return [
        word
        for word, _count in sorted(
            counts.items(), key=lambda item: (-item[1], item[0])
        )[:12]
    ]


def process(job: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(prefix="transcript-worker-") as directory:
        cwd = Path(directory)
        info = metadata(job["sourceUrl"], cwd)
        captions = fetch_captions(job["sourceUrl"], cwd)
        if captions:
            segments, source = captions
        else:
            segments, source = transcribe_audio(job["sourceUrl"], cwd, info)
        transcript = build_transcript(job, info, segments, source)
        request_json(
            f"/api/worker/{job['id']}/complete", transcript, timeout=300
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Process at most one job")
    parser.add_argument("--check", action="store_true", help="Validate dependencies")
    args = parser.parse_args()

    if not REGISTRY_URL or not WORKER_TOKEN:
        raise SystemExit("REGISTRY_URL and WORKER_TOKEN are required")
    if not shutil.which(YT_DLP_BINARY):
        raise SystemExit(f"yt-dlp not found: {YT_DLP_BINARY}")
    if args.check:
        print("worker ready")
        return 0

    while True:
        response = request_json("/api/worker/claim", {"workerId": WORKER_ID})
        job = response.get("job")
        if not job:
            if args.once:
                return 0
            time.sleep(POLL_SECONDS)
            continue
        try:
            process(job)
            print(f"completed {job['providerId']}", flush=True)
        except Exception as error:  # noqa: BLE001
            message = str(error)[:1000]
            print(f"failed {job['providerId']}: {message}", flush=True)
            request_json(f"/api/worker/{job['id']}/fail", {"error": message})
        if args.once:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
