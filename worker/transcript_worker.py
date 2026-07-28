#!/usr/bin/env python3
"""Owner-operated discovery and transcript worker.

It discovers Creative Commons captioned videos for missing topics, prefers
creator captions, falls back to automatic captions, and uses local MLX Whisper
or whisper.cpp only when needed and permitted.
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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from concurrent.futures import Future, ThreadPoolExecutor


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
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
DISCOVERY_LANGUAGE = os.environ.get("DISCOVERY_LANGUAGE", "en")
DISCOVERY_REGION = os.environ.get("DISCOVERY_REGION", "US")
WORKER_CONCURRENCY = max(
    1, min(int(os.environ.get("WORKER_CONCURRENCY", "4")), 8)
)
ASR_CONCURRENCY = max(1, min(int(os.environ.get("ASR_CONCURRENCY", "1")), 2))
CHANNEL_BATCH_SIZE = max(
    10, min(int(os.environ.get("CHANNEL_BATCH_SIZE", "50")), 100)
)
ASR_SEMAPHORE = threading.BoundedSemaphore(ASR_CONCURRENCY)

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
    attempts = 1 if path.endswith("/claim") else 3
    for attempt in range(attempts):
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
            retryable = error.code == 429 or error.code >= 500
            if not retryable or attempt + 1 >= attempts:
                raise RuntimeError(
                    f"Registry returned HTTP {error.code}: {detail}"
                ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt + 1 >= attempts:
                raise RuntimeError(
                    f"Registry request failed after {attempts} attempt(s): {error}"
                ) from error
        time.sleep(2**attempt)
    raise RuntimeError("Registry request failed")


def report_failure(path: str, payload: dict[str, Any], label: str) -> None:
    """Report a failed job without allowing a second network error to kill the worker."""
    try:
        request_json(path, payload)
    except Exception as error:  # noqa: BLE001
        print(f"could not report {label} failure: {error}", flush=True)


def claim_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Treat a transient claim error as an idle poll, not a worker crash."""
    try:
        return request_json(path, payload)
    except Exception as error:  # noqa: BLE001
        print(f"claim request failed for {path}: {error}", flush=True)
        return {}


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
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="transcript-worker-") as directory:
        cwd = Path(directory)
        info = metadata(job["sourceUrl"], cwd)
        captions = fetch_captions(job["sourceUrl"], cwd)
        if captions:
            segments, source = captions
        else:
            with ASR_SEMAPHORE:
                segments, source = transcribe_audio(job["sourceUrl"], cwd, info)
        transcript = build_transcript(job, info, segments, source)
        transcript["processingSeconds"] = max(
            1, round(time.monotonic() - started)
        )
        request_json(
            f"/api/worker/{job['id']}/complete", transcript, timeout=300
        )


def handle_video(job: dict[str, Any]) -> None:
    started = time.monotonic()
    try:
        process(job)
        print(f"completed video {job['providerId']}", flush=True)
    except Exception as error:  # noqa: BLE001
        elapsed = max(1, round(time.monotonic() - started))
        message = str(error)[:1000]
        print(f"failed video {job['providerId']}: {message}", flush=True)
        report_failure(
            f"/api/worker/{job['id']}/fail",
            {"error": message, "processingSeconds": elapsed},
            f"video {job['providerId']}",
        )


def discover_with_youtube_api(query: str, limit: int) -> list[str]:
    if not YOUTUBE_API_KEY:
        return []
    parameters = urllib.parse.urlencode(
        {
            "part": "snippet",
            "type": "video",
            "q": query,
            "maxResults": min(limit, 25),
            "videoCaption": "closedCaption",
            "videoLicense": "creativeCommon",
            "safeSearch": "moderate",
            "relevanceLanguage": DISCOVERY_LANGUAGE,
            "regionCode": DISCOVERY_REGION,
            "key": YOUTUBE_API_KEY,
        }
    )
    request = urllib.request.Request(
        f"https://www.googleapis.com/youtube/v3/search?{parameters}",
        headers={"User-Agent": "transcript-registry-worker/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return [
        f"https://www.youtube.com/watch?v={item['id']['videoId']}"
        for item in payload.get("items", [])
        if isinstance(item.get("id"), dict) and item["id"].get("videoId")
    ]


def discover_with_ytdlp(query: str, limit: int) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="topic-discovery-") as directory:
        output = run(
            [
                YT_DLP_BINARY,
                "--dump-single-json",
                "--flat-playlist",
                "--skip-download",
                "--no-warnings",
                "--playlist-end",
                str(limit),
                f"ytsearch{limit}:{query}",
            ],
            Path(directory),
            timeout=300,
        )
    payload = json.loads(output)
    urls: list[str] = []
    for item in payload.get("entries", []):
        video_id = str(item.get("id") or "")
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            urls.append(f"https://www.youtube.com/watch?v={video_id}")
    return urls


def discover_topic(job: dict[str, Any]) -> list[str]:
    query = str(job.get("query") or "").strip()
    limit = max(1, min(int(job.get("targetCount") or 8), 25))
    if YOUTUBE_API_KEY:
        try:
            urls = discover_with_youtube_api(query, limit)
            if urls:
                return urls
        except (
            urllib.error.URLError,
            TimeoutError,
            KeyError,
            json.JSONDecodeError,
        ) as error:
            print(
                f"YouTube API discovery failed; using yt-dlp: {error}",
                flush=True,
            )
    return discover_with_ytdlp(query, limit)


def process_topic(job: dict[str, Any]) -> None:
    request_json(
        f"/api/worker/topics/{job['id']}/complete",
        {"videoUrls": discover_topic(job)},
        timeout=180,
    )


def youtube_api_json(resource: str, parameters: dict[str, Any]) -> dict[str, Any]:
    query = urllib.parse.urlencode({**parameters, "key": YOUTUBE_API_KEY})
    request = urllib.request.Request(
        f"https://www.googleapis.com/youtube/v3/{resource}?{query}",
        headers={"User-Agent": "transcript-registry-worker/2.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def discover_channels_with_api(
    query: str, limit: int
) -> list[dict[str, str]]:
    if not YOUTUBE_API_KEY:
        return []
    payload = youtube_api_json(
        "search",
        {
            "part": "snippet",
            "type": "channel",
            "q": query,
            "maxResults": min(limit, 15),
            "order": "relevance",
            "safeSearch": "moderate",
            "relevanceLanguage": DISCOVERY_LANGUAGE,
            "regionCode": DISCOVERY_REGION,
        },
    )
    results: list[dict[str, str]] = []
    for item in payload.get("items") or []:
        identifier = item.get("id") or {}
        snippet = item.get("snippet") or {}
        channel_id = str(identifier.get("channelId") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{10,100}", channel_id):
            continue
        results.append(
            {
                "channelId": channel_id,
                "name": str(snippet.get("title") or channel_id),
                "url": f"https://www.youtube.com/channel/{channel_id}",
                "description": str(snippet.get("description") or ""),
            }
        )
    return results


def discover_channels_with_ytdlp(
    query: str, limit: int
) -> list[dict[str, str]]:
    search_limit = max(20, min(limit * 5, 75))
    with tempfile.TemporaryDirectory(prefix="channel-search-") as directory:
        output = run(
            [
                YT_DLP_BINARY,
                "--dump-single-json",
                "--flat-playlist",
                "--skip-download",
                "--no-warnings",
                "--playlist-end",
                str(search_limit),
                f"ytsearch{search_limit}:{query}",
            ],
            Path(directory),
            timeout=300,
        )
    payload = json.loads(output)
    candidates: dict[str, dict[str, str]] = {}
    for item in payload.get("entries") or []:
        channel_id = str(item.get("channel_id") or "")
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]{10,100}", channel_id)
            or channel_id in candidates
        ):
            continue
        name = str(
            item.get("channel")
            or item.get("uploader")
            or item.get("channel_url")
            or channel_id
        )
        candidates[channel_id] = {
            "channelId": channel_id,
            "name": name,
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "description": (
                f"Found through the matching video: "
                f"{str(item.get('title') or '').strip()}"
            ).strip(),
        }
        if len(candidates) >= limit:
            break
    return list(candidates.values())


def discover_channel_candidates(job: dict[str, Any]) -> list[dict[str, str]]:
    query = str(job.get("query") or "").strip()
    limit = max(1, min(int(job.get("resultLimit") or 8), 15))
    if YOUTUBE_API_KEY:
        try:
            results = discover_channels_with_api(query, limit)
            if results:
                return results
        except (
            urllib.error.URLError,
            TimeoutError,
            KeyError,
            json.JSONDecodeError,
        ) as error:
            print(
                f"YouTube channel search API failed; using yt-dlp: {error}",
                flush=True,
            )
    return discover_channels_with_ytdlp(query, limit)


def process_channel_search(job: dict[str, Any]) -> None:
    request_json(
        f"/api/worker/channel-searches/{job['id']}/complete",
        {"channels": discover_channel_candidates(job)},
        timeout=180,
    )


def channel_api_filter(url: str) -> dict[str, str] | None:
    parts = [part for part in urllib.parse.urlparse(url).path.split("/") if part]
    if not parts:
        return None
    if parts[0].startswith("@"):
        return {"forHandle": parts[0]}
    if len(parts) > 1 and parts[0] == "channel":
        return {"id": parts[1]}
    if len(parts) > 1 and parts[0] == "user":
        return {"forUsername": parts[1]}
    return None


def send_channel_batch(
    job: dict[str, Any],
    videos: list[dict[str, str]],
    metadata_payload: dict[str, Any],
) -> None:
    if not videos:
        return
    request_json(
        f"/api/worker/channels/{job['id']}/batch",
        {**metadata_payload, "videos": videos},
        timeout=180,
    )
    print(
        f"channel {job['id']} discovered batch of {len(videos)}",
        flush=True,
    )


def send_channel_metadata(
    job: dict[str, Any],
    metadata_payload: dict[str, Any],
) -> None:
    request_json(
        f"/api/worker/channels/{job['id']}/batch",
        {**metadata_payload, "videos": []},
        timeout=180,
    )


def discover_channel_with_api(job: dict[str, Any]) -> bool:
    if not YOUTUBE_API_KEY:
        return False
    channel_filter = channel_api_filter(str(job["normalizedUrl"]))
    if not channel_filter:
        return False
    payload = youtube_api_json(
        "channels",
        {
            "part": "snippet,contentDetails,statistics",
            **channel_filter,
        },
    )
    items = payload.get("items") or []
    if not items:
        raise RuntimeError("YouTube API could not resolve this channel")
    channel = items[0]
    channel_id = str(channel.get("id") or "")
    snippet = channel.get("snippet") or {}
    details = channel.get("contentDetails") or {}
    statistics = channel.get("statistics") or {}
    uploads = str(
        (details.get("relatedPlaylists") or {}).get("uploads") or ""
    )
    if not uploads:
        raise RuntimeError("YouTube API did not return the uploads playlist")
    metadata_payload = {
        "channelId": channel_id,
        "channelName": str(snippet.get("title") or channel_id),
        "channelUrl": f"https://www.youtube.com/channel/{channel_id}",
        "reportedVideoCount": int(statistics.get("videoCount") or 0),
    }
    send_channel_metadata(job, metadata_payload)
    batch_size = max(
        10, min(int(job.get("batchSize") or CHANNEL_BATCH_SIZE), 100)
    )
    batch: list[dict[str, str]] = []
    page_token = ""
    while True:
        page = youtube_api_json(
            "playlistItems",
            {
                "part": "snippet,contentDetails",
                "playlistId": uploads,
                "maxResults": 50,
                **({"pageToken": page_token} if page_token else {}),
            },
        )
        for item in page.get("items") or []:
            content = item.get("contentDetails") or {}
            item_snippet = item.get("snippet") or {}
            resource = item_snippet.get("resourceId") or {}
            video_id = str(
                content.get("videoId") or resource.get("videoId") or ""
            )
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                continue
            batch.append(
                {
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                    "title": str(item_snippet.get("title") or video_id),
                }
            )
            if len(batch) >= batch_size:
                send_channel_batch(job, batch, metadata_payload)
                batch = []
        page_token = str(page.get("nextPageToken") or "")
        if not page_token:
            break
    send_channel_batch(job, batch, metadata_payload)
    request_json(f"/api/worker/channels/{job['id']}/complete", {})
    return True


def channel_targets(url: str) -> list[str]:
    base = url.rstrip("/")
    return [f"{base}/videos", f"{base}/shorts", f"{base}/streams"]


def discover_channel_with_ytdlp(job: dict[str, Any]) -> None:
    batch_size = max(
        10, min(int(job.get("batchSize") or CHANNEL_BATCH_SIZE), 100)
    )
    batch: list[dict[str, str]] = []
    seen: set[str] = set()
    metadata_payload: dict[str, Any] = {}
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="channel-discovery-") as directory:
        cwd = Path(directory)
        try:
            preview = json.loads(
                run(
                    [
                        YT_DLP_BINARY,
                        "--dump-single-json",
                        "--flat-playlist",
                        "--skip-download",
                        "--no-warnings",
                        "--playlist-end",
                        "1",
                        channel_targets(str(job["normalizedUrl"]))[0],
                    ],
                    cwd,
                    timeout=300,
                )
            )
            channel_id = str(preview.get("channel_id") or preview.get("id") or "")
            channel_name = str(
                preview.get("channel") or preview.get("uploader") or ""
            )
            if channel_id:
                metadata_payload["channelId"] = channel_id
                metadata_payload["channelUrl"] = (
                    f"https://www.youtube.com/channel/{channel_id}"
                )
            if channel_name:
                metadata_payload["channelName"] = channel_name
            send_channel_metadata(job, metadata_payload)
        except (RuntimeError, json.JSONDecodeError):
            pass
        for target in channel_targets(str(job["normalizedUrl"])):
            with tempfile.TemporaryFile(mode="w+") as errors_file:
                command = [
                    YT_DLP_BINARY,
                    "--flat-playlist",
                    "--lazy-playlist",
                    "--dump-json",
                    "--skip-download",
                    "--no-warnings",
                    "--yes-playlist",
                    target,
                ]
                process = subprocess.Popen(
                    command,
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=errors_file,
                    text=True,
                )
                assert process.stdout is not None
                for line in process.stdout:
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    video_id = str(item.get("id") or "")
                    if (
                        not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id)
                        or video_id in seen
                    ):
                        continue
                    seen.add(video_id)
                    channel_id = str(item.get("channel_id") or "")
                    channel_name = str(
                        item.get("channel") or item.get("uploader") or ""
                    )
                    if channel_id:
                        metadata_payload["channelId"] = channel_id
                        metadata_payload["channelUrl"] = (
                            f"https://www.youtube.com/channel/{channel_id}"
                        )
                    if channel_name:
                        metadata_payload["channelName"] = channel_name
                    playlist_count = item.get("playlist_count")
                    if isinstance(playlist_count, int):
                        metadata_payload["reportedVideoCount"] = max(
                            int(metadata_payload.get("reportedVideoCount") or 0),
                            playlist_count,
                        )
                    batch.append(
                        {
                            "url": f"https://www.youtube.com/watch?v={video_id}",
                            "title": str(item.get("title") or video_id),
                        }
                    )
                    if len(batch) >= batch_size:
                        send_channel_batch(job, batch, metadata_payload)
                        batch = []
                return_code = process.wait(timeout=60)
                if return_code:
                    errors_file.seek(0)
                    errors.append(errors_file.read()[-1000:])
    send_channel_batch(job, batch, metadata_payload)
    if not seen and errors:
        raise RuntimeError(errors[-1] or "yt-dlp found no public channel videos")
    send_channel_metadata(
        job,
        {**metadata_payload, "reportedVideoCount": len(seen)},
    )
    request_json(f"/api/worker/channels/{job['id']}/complete", {})


def process_channel(job: dict[str, Any]) -> None:
    if YOUTUBE_API_KEY:
        try:
            if discover_channel_with_api(job):
                return
        except (
            urllib.error.URLError,
            TimeoutError,
            KeyError,
            ValueError,
            json.JSONDecodeError,
            RuntimeError,
        ) as error:
            print(
                f"YouTube channel API failed; using yt-dlp: {error}",
                flush=True,
            )
    discover_channel_with_ytdlp(job)


def handle_channel(job: dict[str, Any]) -> None:
    try:
        process_channel(job)
        print(f"completed channel discovery {job['normalizedUrl']}", flush=True)
    except Exception as error:  # noqa: BLE001
        message = str(error)[:1000]
        print(f"failed channel {job['normalizedUrl']}: {message}", flush=True)
        report_failure(
            f"/api/worker/channels/{job['id']}/fail",
            {"error": message},
            f"channel {job['id']}",
        )


def handle_channel_search(job: dict[str, Any]) -> None:
    try:
        process_channel_search(job)
        print(f"completed channel search {job['query']}", flush=True)
    except Exception as error:  # noqa: BLE001
        message = str(error)[:1000]
        print(f"failed channel search {job['query']}: {message}", flush=True)
        report_failure(
            f"/api/worker/channel-searches/{job['id']}/fail",
            {"error": message},
            f"channel search {job['id']}",
        )


def handle_topic(job: dict[str, Any]) -> None:
    try:
        process_topic(job)
        print(f"completed topic {job['query']}", flush=True)
    except Exception as error:  # noqa: BLE001
        message = str(error)[:1000]
        print(f"failed topic {job['query']}: {message}", flush=True)
        report_failure(
            f"/api/worker/topics/{job['id']}/fail",
            {"error": message},
            f"topic {job['id']}",
        )


def process_once() -> None:
    channel = request_json(
        "/api/worker/channels/claim", {"workerId": WORKER_ID}
    ).get("job")
    if channel:
        handle_channel(channel)
        return
    response = request_json(
        "/api/worker/claim",
        {"workerId": WORKER_ID, "limit": 1},
    )
    jobs = response.get("jobs") or (
        [response["job"]] if response.get("job") else []
    )
    if jobs:
        handle_video(jobs[0])
        return
    channel_search = request_json(
        "/api/worker/channel-searches/claim", {"workerId": WORKER_ID}
    ).get("job")
    if channel_search:
        handle_channel_search(channel_search)
        return
    topic = request_json(
        "/api/worker/topics/claim", {"workerId": WORKER_ID}
    ).get("job")
    if topic:
        handle_topic(topic)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process at most one channel, transcript, or topic job",
    )
    parser.add_argument("--check", action="store_true", help="Validate dependencies")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=WORKER_CONCURRENCY,
        help="Maximum concurrent video jobs (default: WORKER_CONCURRENCY or 4)",
    )
    args = parser.parse_args()

    if not REGISTRY_URL or not WORKER_TOKEN:
        raise SystemExit("REGISTRY_URL and WORKER_TOKEN are required")
    if not shutil.which(YT_DLP_BINARY):
        raise SystemExit(f"yt-dlp not found: {YT_DLP_BINARY}")
    if args.check:
        print(
            "worker ready "
            f"(video concurrency={max(1, min(args.concurrency, 8))}, "
            f"ASR concurrency={ASR_CONCURRENCY}, "
            f"channel batch={CHANNEL_BATCH_SIZE})"
        )
        return 0
    if args.once:
        process_once()
        return 0

    concurrency = max(1, min(args.concurrency, 8))
    video_futures: set[Future[None]] = set()
    discovery_future: Future[None] | None = None
    next_discovery_poll = 0.0
    with (
        ThreadPoolExecutor(
            max_workers=concurrency,
            thread_name_prefix="transcript",
        ) as video_executor,
        ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="discovery",
        ) as discovery_executor,
    ):
        while True:
            progressed = False
            finished = {future for future in video_futures if future.done()}
            for future in finished:
                try:
                    future.result()
                except Exception as error:  # noqa: BLE001
                    print(f"video task crashed: {error}", flush=True)
            if finished:
                video_futures.difference_update(finished)
                progressed = True
            if discovery_future and discovery_future.done():
                try:
                    discovery_future.result()
                except Exception as error:  # noqa: BLE001
                    print(f"discovery task crashed: {error}", flush=True)
                discovery_future = None
                progressed = True

            now = time.monotonic()
            if discovery_future is None and now >= next_discovery_poll:
                channel = claim_json(
                    "/api/worker/channels/claim",
                    {"workerId": WORKER_ID},
                ).get("job")
                if channel:
                    discovery_future = discovery_executor.submit(
                        handle_channel,
                        channel,
                    )
                    progressed = True
                else:
                    channel_search = claim_json(
                        "/api/worker/channel-searches/claim",
                        {"workerId": WORKER_ID},
                    ).get("job")
                    if channel_search:
                        discovery_future = discovery_executor.submit(
                            handle_channel_search,
                            channel_search,
                        )
                        progressed = True
                    else:
                        next_discovery_poll = now + 5

            open_slots = concurrency - len(video_futures)
            claimed_video = False
            if open_slots > 0:
                response = claim_json(
                    "/api/worker/claim",
                    {"workerId": WORKER_ID, "limit": open_slots},
                )
                claimed = response.get("jobs") or (
                    [response["job"]] if response.get("job") else []
                )
                for job in claimed:
                    video_futures.add(video_executor.submit(handle_video, job))
                if claimed:
                    claimed_video = True
                    progressed = True

            if (
                discovery_future is None
                and not video_futures
                and not claimed_video
            ):
                topic = claim_json(
                    "/api/worker/topics/claim",
                    {"workerId": WORKER_ID},
                ).get("job")
                if topic:
                    discovery_future = discovery_executor.submit(
                        handle_topic,
                        topic,
                    )
                    progressed = True

            if not progressed:
                time.sleep(
                    0.75
                    if video_futures or discovery_future
                    else POLL_SECONDS
                )


if __name__ == "__main__":
    raise SystemExit(main())
