#!/usr/bin/env python3
"""Import an attributed CC-BY corpus into a deployed Transcript Registry."""

from __future__ import annotations

import argparse
import heapq
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

import pyarrow.parquet as pq


WORD = re.compile(r"[a-z][a-z0-9-]{3,}")
HEALTHCARE = re.compile(
    r"\b(health(?:care)?|medical|medicine|diabet\w*|cancer|disease|patient|"
    r"doctor|hospital|nutrition|mental health|therapy|covid|heart|blood|"
    r"surgery|symptom|treatment|nursing|anatomy|pharmacy|clinical|wellness|"
    r"insulin|dental|dentist|brain|pregnan\w*|vaccine|physician|medicare|"
    r"psycholog\w*|exercise|fitness|workout|weight loss|diet|clinic|"
    r"diagnos\w*|drug|alcohol|addiction|depression|anxiety|sleep|kidney|"
    r"liver|lung|bone|immune|infection|virus|bacteria|stroke|emergency|"
    r"first aid|public health|dementia|autism|adhd|disability|trauma|stress|"
    r"disorder|syndrome|epidemic|pandemic|hygiene|pain|injury|rehabilitation|"
    r"physiotherapy|surgical)\b",
    re.IGNORECASE,
)
STOP = {
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


def records(
    path: Path, limit: int, healthcare_only: bool = False
) -> Iterable[dict[str, Any]]:
    source = pq.ParquetFile(path)
    seen: set[str] = set()
    selected = 0
    ranked: list[tuple[int, int, dict[str, Any]]] = []
    serial = 0
    columns = [
        "video_id",
        "video_link",
        "title",
        "text",
        "channel",
        "channel_id",
        "date",
        "license",
        "original_language",
        "transcription_language",
    ]
    for batch in source.iter_batches(batch_size=256, columns=columns):
        for row in batch.to_pylist():
            video_id = str(row.get("video_id") or "")
            text = re.sub(r"\s+", " ", str(row.get("text") or "")).strip()
            language = str(row.get("transcription_language") or "").lower()
            original_language = str(row.get("original_language") or "").lower()
            if (
                not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id)
                or video_id in seen
                or language != "en"
                or original_language != "en"
                or len(text) < 200
                or len(text) > 1_500_000
            ):
                continue
            title = str(row.get("title") or video_id)
            seen.add(video_id)
            channel = str(row.get("channel") or "")
            record = {
                "provider": "youtube",
                "providerId": video_id,
                "sourceUrl": str(row.get("video_link") or "")
                or f"https://www.youtube.com/watch?v={video_id}",
                "title": title,
                "channel": channel,
                "channelUrl": (
                    f"https://www.youtube.com/channel/{row['channel_id']}"
                    if row.get("channel_id")
                    else None
                ),
                "description": "",
                "publishedAt": str(row.get("date") or "") or None,
                "durationSeconds": None,
                "language": "en",
                "transcriptSource": "licensed-dataset",
                "license": str(row.get("license") or "CC-BY"),
                "attribution": (
                    f"{channel}; transcript supplied by the CC-BY "
                    "PleIAs/YouTube-Commons dataset."
                ),
                "topics": topics(f"{title} {text[:4000]}"),
                "transcriptText": text,
                "segments": [{"start": 0, "end": None, "text": text}],
            }
            if healthcare_only:
                score = healthcare_score(title, channel, text)
                if score <= 0:
                    continue
                serial += 1
                item = (score, serial, record)
                if len(ranked) < limit:
                    heapq.heappush(ranked, item)
                elif score > ranked[0][0]:
                    heapq.heapreplace(ranked, item)
                continue

            yield record
            selected += 1
            if selected >= limit:
                return

    if healthcare_only:
        for _score, _serial, record in sorted(ranked, reverse=True):
            yield record


def healthcare_score(title: str, channel: str, text: str) -> int:
    title_hits = HEALTHCARE.findall(title)
    channel_hits = HEALTHCARE.findall(channel)
    text_hits = [match.lower() for match in HEALTHCARE.findall(text)]
    distinct = len(set(text_hits))
    if not title_hits and not channel_hits and (len(text_hits) < 2 or distinct < 2):
        return 0
    return (
        len(title_hits) * 250
        + len(channel_hits) * 100
        + distinct * 20
        + min(len(text_hits), 200)
    )


def topics(value: str) -> list[str]:
    counts: dict[str, int] = {}
    for word in WORD.findall(value.lower()):
        if word in STOP:
            continue
        counts[word] = counts.get(word, 0) + 1
    return [
        key
        for key, _count in sorted(
            counts.items(), key=lambda item: (-item[1], item[0])
        )[:12]
    ]


def upload(
    base_url: str, token: str, batch: list[dict[str, Any]]
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/admin/import",
        data=json.dumps({"records": batch}).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "transcript-registry-importer/1.0",
        },
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--file",
        default=os.environ.get(
            "COMMONS_PARQUET", "/private/tmp/youtube-commons-0.parquet"
        ),
    )
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument(
        "--healthcare",
        action="store_true",
        help="Select healthcare-related records first",
    )
    parser.add_argument(
        "--output",
        help="Write JSONL locally instead of uploading (used for validation)",
    )
    args = parser.parse_args()
    path = Path(args.file)
    if not path.exists():
        raise SystemExit(f"Dataset file not found: {path}")

    if args.output:
        destination = Path(args.output)
        with destination.open("w", encoding="utf-8") as stream:
            count = 0
            for record in records(path, args.limit, args.healthcare):
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                count += 1
        print(f"prepared {count} records")
        return 0 if count >= args.limit else 1

    base_url = os.environ.get("REGISTRY_URL", "")
    token = os.environ.get("WORKER_TOKEN", "")
    if not base_url or not token:
        raise SystemExit("REGISTRY_URL and WORKER_TOKEN are required")

    imported = 0
    batch: list[dict[str, Any]] = []
    for record in records(path, args.limit, args.healthcare):
        batch.append(record)
        if len(batch) < args.batch_size:
            continue
        result = upload(base_url, token, batch)
        imported += int(result.get("imported", 0))
        if result.get("errors"):
            raise RuntimeError(json.dumps(result["errors"]))
        print(f"imported {imported}/{args.limit}", flush=True)
        batch = []
    if batch:
        result = upload(base_url, token, batch)
        imported += int(result.get("imported", 0))
    print(f"import complete: {imported}")
    return 0 if imported >= args.limit else 1


if __name__ == "__main__":
    raise SystemExit(main())
