from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from worker import transcript_worker as worker


class ChannelWorkerTests(unittest.TestCase):
    def test_registry_writes_retry_after_a_transient_timeout(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self) -> bytes:
                return json.dumps({"ok": True}).encode()

        with (
            patch.object(worker, "REGISTRY_URL", "https://registry.example"),
            patch.object(
                worker.urllib.request,
                "urlopen",
                side_effect=[TimeoutError("temporary"), FakeResponse()],
            ) as urlopen,
            patch.object(worker.time, "sleep") as sleep,
        ):
            result = worker.request_json("/api/worker/job/complete", {})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_claims_are_not_retried_after_an_ambiguous_timeout(self) -> None:
        with (
            patch.object(worker, "REGISTRY_URL", "https://registry.example"),
            patch.object(
                worker.urllib.request,
                "urlopen",
                side_effect=TimeoutError("ambiguous"),
            ) as urlopen,
            patch.object(worker.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "after 1 attempt"):
                worker.request_json("/api/worker/claim", {})

        urlopen.assert_called_once()
        sleep.assert_not_called()

    def test_channel_targets_cover_videos_shorts_and_streams(self) -> None:
        self.assertEqual(
            worker.channel_targets("https://www.youtube.com/@example"),
            [
                "https://www.youtube.com/@example/videos",
                "https://www.youtube.com/@example/shorts",
                "https://www.youtube.com/@example/streams",
            ],
        )

    def test_official_api_paginates_and_uploads_in_batches(self) -> None:
        videos = [
            {
                "snippet": {
                    "title": f"Video {index}",
                    "resourceId": {"videoId": f"A{index:010d}"},
                },
                "contentDetails": {"videoId": f"A{index:010d}"},
            }
            for index in range(120)
        ]

        def fake_api(resource: str, parameters: dict[str, object]):
            if resource == "channels":
                return {
                    "items": [
                        {
                            "id": "UC123",
                            "snippet": {"title": "Example"},
                            "contentDetails": {
                                "relatedPlaylists": {"uploads": "UU123"}
                            },
                            "statistics": {"videoCount": "120"},
                        }
                    ]
                }
            token = str(parameters.get("pageToken") or "")
            if not token:
                return {"items": videos[:50], "nextPageToken": "page-2"}
            if token == "page-2":
                return {"items": videos[50:100], "nextPageToken": "page-3"}
            return {"items": videos[100:]}

        requests: list[tuple[str, dict[str, object]]] = []

        def fake_request(
            path: str,
            payload: dict[str, object],
            timeout: int = 120,
        ):
            del timeout
            requests.append((path, payload))
            return {}

        job = {
            "id": "channel-job",
            "normalizedUrl": "https://www.youtube.com/@example",
            "batchSize": 50,
        }
        with (
            patch.object(worker, "YOUTUBE_API_KEY", "test-key"),
            patch.object(worker, "youtube_api_json", side_effect=fake_api),
            patch.object(worker, "request_json", side_effect=fake_request),
        ):
            self.assertTrue(worker.discover_channel_with_api(job))

        batch_sizes = [
            len(payload["videos"])
            for path, payload in requests
            if path.endswith("/batch")
        ]
        self.assertEqual(batch_sizes, [0, 50, 50, 20])
        self.assertEqual(requests[0][1]["channelName"], "Example")
        self.assertEqual(requests[0][1]["reportedVideoCount"], 120)
        self.assertTrue(requests[-1][0].endswith("/complete"))


if __name__ == "__main__":
    unittest.main()
