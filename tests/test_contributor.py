from __future__ import annotations

import argparse
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "public" / "contribute.py"
SPEC = importlib.util.spec_from_file_location("transcript_contributor", MODULE_PATH)
assert SPEC and SPEC.loader
contributor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contributor)


class ContributorTests(unittest.TestCase):
    def test_vtt_parser_removes_rolling_caption_overlap(self) -> None:
        segments = contributor.parse_vtt(
            """WEBVTT

00:00:01.000 --> 00:00:03.000
hello world

00:00:03.000 --> 00:00:05.000
hello world from captions
"""
        )
        self.assertEqual(
            [segment["text"] for segment in segments],
            ["hello world", "from captions"],
        )

    def test_existing_transcript_finishes_without_local_compute(self) -> None:
        args = argparse.Namespace(
            video_url="abcdefghijk",
            registry="https://registry.example",
            install_tools=False,
            install_asr=False,
            allow_asr=False,
            force_asr=False,
            mlx_model="model",
        )
        with patch.object(
            contributor,
            "request_json",
            return_value={
                "status": "complete",
                "transcript": "https://registry.example/youtube/abcdefghijk",
                "text": "https://registry.example/youtube/abcdefghijk.txt",
                "json": "https://registry.example/youtube/abcdefghijk.json",
            },
        ):
            result = contributor.contribute(args)
        self.assertTrue(result["reused"])
        self.assertEqual(result["status"], "complete")

    def test_caption_contribution_uploads_only_structured_text(self) -> None:
        args = argparse.Namespace(
            video_url="abcdefghijk",
            registry="https://registry.example",
            install_tools=False,
            install_asr=False,
            allow_asr=False,
            force_asr=False,
            mlx_model="model",
        )
        calls: list[tuple[str, dict[str, object], str | None]] = []

        def fake_request(
            url: str,
            payload: dict[str, object],
            token: str | None = None,
            timeout: int = 300,
        ) -> dict[str, object]:
            del timeout
            calls.append((url, payload, token))
            if url.endswith("/prepare"):
                return {
                    "status": "ready",
                    "videoId": "abcdefghijk",
                    "source": "https://www.youtube.com/watch?v=abcdefghijk",
                    "token": "job-token",
                    "upload": "https://registry.example/complete",
                    "release": "https://registry.example/release",
                    "afterCompletion": {
                        "text": "https://registry.example/youtube/abcdefghijk.txt"
                    },
                }
            return {"status": "complete"}

        with (
            patch.object(contributor, "request_json", side_effect=fake_request),
            patch.object(contributor, "yt_dlp_command", return_value=["yt-dlp"]),
            patch.object(
                contributor,
                "metadata",
                return_value={
                    "title": "Example",
                    "channel": "Example Channel",
                    "description": "",
                    "duration": 10,
                },
            ),
            patch.object(
                contributor,
                "fetch_captions",
                return_value=(
                    [{"start": 0, "end": 2, "text": "hello world"}],
                    "creator-captions",
                ),
            ),
        ):
            result = contributor.contribute(args)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["method"], "creator-captions")
        upload = calls[1]
        self.assertEqual(upload[2], "job-token")
        self.assertNotIn("audio", json.dumps(upload[1]).lower())
        self.assertEqual(upload[1]["transcriptText"], "hello world")

    def test_force_asr_skips_caption_fetch_and_confirms_rights(self) -> None:
        args = argparse.Namespace(
            video_url="abcdefghijk",
            registry="https://registry.example",
            install_tools=False,
            install_asr=False,
            allow_asr=True,
            force_asr=True,
            mlx_model="model",
        )
        uploads: list[dict[str, object]] = []

        def fake_request(
            url: str,
            payload: dict[str, object],
            token: str | None = None,
            timeout: int = 300,
        ) -> dict[str, object]:
            del token, timeout
            if url.endswith("/prepare"):
                return {
                    "status": "ready",
                    "videoId": "abcdefghijk",
                    "source": "https://www.youtube.com/watch?v=abcdefghijk",
                    "token": "job-token",
                    "upload": "https://registry.example/complete",
                    "release": "https://registry.example/release",
                    "afterCompletion": {},
                }
            uploads.append(payload)
            return {"status": "complete"}

        with (
            patch.object(contributor, "request_json", side_effect=fake_request),
            patch.object(contributor, "yt_dlp_command", return_value=["yt-dlp"]),
            patch.object(
                contributor,
                "metadata",
                return_value={
                    "title": "Example",
                    "channel": "Example Channel",
                    "description": "",
                    "duration": 10,
                },
            ),
            patch.object(contributor, "fetch_captions") as fetch_captions,
            patch.object(
                contributor,
                "transcribe_audio",
                return_value=[
                    {"start": 0, "end": 2, "text": "local whisper"}
                ],
            ),
        ):
            result = contributor.contribute(args)

        fetch_captions.assert_not_called()
        self.assertEqual(result["method"], "local-asr")
        self.assertTrue(uploads[0]["rightsConfirmed"])


if __name__ == "__main__":
    unittest.main()
