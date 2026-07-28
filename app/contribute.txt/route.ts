import { textResponse } from "../../lib/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  return textResponse(
    [
      "Transcript Registry local contribution",
      "",
      "Use this only from a coding agent or terminal running on the user's computer.",
      "The agent must not download audio into its model context or print transcript contents.",
      "",
      "Safer two-step command:",
      `curl -fsSLo transcript-contribute.py ${origin}/contribute.py`,
      `python3 transcript-contribute.py YOUTUBE_URL --registry ${origin} --allow-asr --install-tools --install-asr`,
      "",
      "Single command:",
      `curl -fsSL ${origin}/contribute.sh | sh -s -- YOUTUBE_URL --registry ${origin} --allow-asr --install-asr`,
      "",
      "The helper checks captions first. If captions are absent and --allow-asr",
      "was supplied, it uses MLX Whisper on Apple Silicon or configured whisper.cpp.",
      "It uploads only transcript text, timestamps, and source metadata. Temporary",
      "captions and audio are deleted. The final transcript is shared with everyone.",
      "",
    ].join("\n"),
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
