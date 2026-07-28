#!/usr/bin/env python3
"""Generate one transcript locally and contribute it to Transcript Registry.

This helper intentionally keeps audio and transcript contents out of the
calling agent's context. Temporary files are removed when the process exits.
"""

from __future__ import annotations

import argparse
import contextlib
import html
import importlib.util
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_REGISTRY = "https://transcript-registry.vercel.app"
DEFAULT_MLX_MODEL = "mlx-community/whisper-small-mlx"
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


class ContributionError(RuntimeError):
    """A concise error safe to print in a coding-agent terminal."""


def request_json(
    url: str,
    payload: dict[str, Any],
    token: str | None = None,
    timeout: int = 300,
) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "transcript-registry-contributor/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        try:
            message = str(json.loads(detail).get("error") or detail)
        except json.JSONDecodeError:
            message = detail
        raise ContributionError(
            f"Registry returned HTTP {error.code}: {message[:1000]}"
        ) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise ContributionError(f"Registry request failed: {error}") from error


def run(command: list[str], cwd: Path, timeout: int) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise ContributionError(
            f"Local command timed out after {timeout} seconds"
        ) from error
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip()
        raise ContributionError(
            detail[-1500:] or f"Local command failed: {command[0]}"
        )
    return completed.stdout


def pip_install(package: str) -> None:
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--quiet",
            package,
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip()
        raise ContributionError(
            f"Could not install {package}: {detail[-1200:]}"
        )


def yt_dlp_command(install_tools: bool) -> list[str]:
    configured = os.environ.get("YT_DLP_BINARY", "").strip()
    if configured:
        resolved = shutil.which(configured) or (
            configured if Path(configured).exists() else ""
        )
        if resolved:
            return [resolved]
    resolved = shutil.which("yt-dlp")
    if resolved:
        return [resolved]
    if importlib.util.find_spec("yt_dlp"):
        return [sys.executable, "-m", "yt_dlp"]
    if install_tools:
        pip_install("yt-dlp==2026.7.4")
        if importlib.util.find_spec("yt_dlp"):
            return [sys.executable, "-m", "yt_dlp"]
    raise ContributionError(
        "yt-dlp is required. Re-run with --install-tools or install yt-dlp."
    )


def metadata(command: list[str], url: str, cwd: Path) -> dict[str, Any]:
    output = run(
        [
            *command,
            "--dump-single-json",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            url,
        ],
        cwd,
        timeout=300,
    )
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise ContributionError("yt-dlp returned invalid metadata") from error


def fetch_captions(
    command: list[str],
    url: str,
    cwd: Path,
) -> tuple[list[dict[str, Any]], str] | None:
    for source, option, stem in (
        ("creator-captions", "--write-subs", "creator"),
        ("automatic-captions", "--write-auto-subs", "automatic"),
    ):
        try:
            run(
                [
                    *command,
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
        except ContributionError:
            continue
        for candidate in sorted(cwd.glob(f"{stem}*.vtt")):
            segments = parse_vtt(
                candidate.read_text("utf-8", errors="replace")
            )
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
        text = re.sub(r"\s+", " ", html.unescape(TAG.sub("", text))).strip()
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
    if not current or current == previous or previous.endswith(current):
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


def transcribe_audio(
    command: list[str],
    url: str,
    cwd: Path,
    install_asr: bool,
    mlx_model: str,
) -> list[dict[str, Any]]:
    run(
        [
            *command,
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
        raise ContributionError("Audio download did not create a WAV file")

    if platform.system() == "Darwin" and platform.machine() == "arm64":
        if install_asr and not importlib.util.find_spec("mlx_whisper"):
            pip_install("mlx-whisper")
        if importlib.util.find_spec("mlx_whisper"):
            quiet = io.StringIO()
            with (
                contextlib.redirect_stdout(quiet),
                contextlib.redirect_stderr(quiet),
            ):
                import mlx_whisper  # type: ignore

                try:
                    from huggingface_hub import logging as hub_logging

                    hub_logging.set_verbosity_error()
                except ImportError:
                    pass
                result = mlx_whisper.transcribe(
                    str(audio),
                    path_or_hf_repo=mlx_model,
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
                return segments

    whisper_binary = os.environ.get(
        "WHISPER_CPP_BINARY", shutil.which("whisper-cli") or ""
    )
    whisper_model = os.environ.get("WHISPER_CPP_MODEL", "")
    if whisper_binary and whisper_model:
        output = cwd / "whisper"
        run(
            [
                whisper_binary,
                "-m",
                whisper_model,
                "-f",
                str(audio),
                "-ojf",
                "-of",
                str(output),
            ],
            cwd,
            timeout=7200,
        )
        result = json.loads((cwd / "whisper.json").read_text("utf-8"))
        segments = parse_whisper_cpp(result)
        if segments:
            return segments

    raise ContributionError(
        "No local ASR engine is ready. On Apple Silicon use --install-asr; "
        "otherwise configure WHISPER_CPP_BINARY and WHISPER_CPP_MODEL."
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


def extract_topics(value: str) -> list[str]:
    counts: dict[str, int] = {}
    for word in TOPIC_WORD.findall(value.lower()):
        if word not in TOPIC_STOP:
            counts[word] = counts.get(word, 0) + 1
    return [
        word
        for word, _count in sorted(
            counts.items(), key=lambda item: (-item[1], item[0])
        )[:12]
    ]


def build_transcript(
    video_id: str,
    source_url: str,
    info: dict[str, Any],
    segments: list[dict[str, Any]],
    source: str,
    processing_seconds: int,
    rights_confirmed: bool,
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
        "providerId": video_id,
        "sourceUrl": source_url,
        "title": str(info.get("title") or video_id),
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
        "processingSeconds": processing_seconds,
        "rightsConfirmed": rights_confirmed,
    }


def contribute(args: argparse.Namespace) -> dict[str, Any]:
    registry = args.registry.rstrip("/")
    prepare = request_json(
        f"{registry}/api/contributions/prepare",
        {"url": args.video_url},
    )
    if prepare.get("status") == "complete":
        return {
            "status": "complete",
            "reused": True,
            "transcript": prepare.get("transcript"),
            "text": prepare.get("text"),
            "json": prepare.get("json"),
        }
    if prepare.get("status") != "ready":
        raise ContributionError(
            str(prepare.get("error") or "Registry did not prepare the job")
        )

    token = str(prepare["token"])
    release_url = str(prepare["release"])
    started = time.monotonic()
    try:
        command = yt_dlp_command(args.install_tools)
        with tempfile.TemporaryDirectory(
            prefix="transcript-contribution-"
        ) as directory:
            cwd = Path(directory)
            source_url = str(prepare["source"])
            info = metadata(command, source_url, cwd)
            captions = (
                None
                if args.force_asr
                else fetch_captions(command, source_url, cwd)
            )
            if captions:
                segments, source = captions
            else:
                if not args.allow_asr:
                    raise ContributionError(
                        "No captions were found. Re-run with --allow-asr only "
                        "if you have permission to transcribe and publish this video."
                    )
                segments = transcribe_audio(
                    command,
                    source_url,
                    cwd,
                    args.install_asr,
                    args.mlx_model,
                )
                source = "local-asr"
            elapsed = max(1, round(time.monotonic() - started))
            transcript = build_transcript(
                str(prepare["videoId"]),
                source_url,
                info,
                segments,
                source,
                elapsed,
                args.allow_asr,
            )
            completed = request_json(
                str(prepare["upload"]),
                transcript,
                token=token,
                timeout=300,
            )
            return {
                "status": completed.get("status"),
                "reused": bool(completed.get("reused")),
                "videoId": prepare["videoId"],
                **dict(prepare.get("afterCompletion") or {}),
                "processingSeconds": elapsed,
                "method": source,
            }
    except Exception as error:
        try:
            request_json(
                release_url,
                {"error": str(error)[:800]},
                token=token,
                timeout=30,
            )
        except Exception:
            pass
        raise


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description=(
            "Use this computer to create one transcript and store it in the "
            "public Transcript Registry."
        )
    )
    value.add_argument("video_url", help="YouTube video URL or video ID")
    value.add_argument(
        "--registry",
        default=os.environ.get("TRANSCRIPT_REGISTRY_URL", DEFAULT_REGISTRY),
        help=f"Registry origin (default: {DEFAULT_REGISTRY})",
    )
    value.add_argument(
        "--allow-asr",
        action="store_true",
        help="Allow local Whisper when captions are absent; confirms permission",
    )
    value.add_argument(
        "--force-asr",
        action="store_true",
        help="Skip available captions and verify the local Whisper path",
    )
    value.add_argument(
        "--install-tools",
        action="store_true",
        help="Install yt-dlp into the current Python environment if missing",
    )
    value.add_argument(
        "--install-asr",
        action="store_true",
        help="Install MLX Whisper on Apple Silicon if ASR is needed",
    )
    value.add_argument(
        "--mlx-model",
        default=os.environ.get("MLX_WHISPER_MODEL", DEFAULT_MLX_MODEL),
        help="MLX Whisper model repository",
    )
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        result = contribute(args)
    except (ContributionError, OSError, ValueError) as error:
        print(
            json.dumps({"status": "failed", "error": str(error)[:1200]}),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
