import { textResponse } from "../../lib/http";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return textResponse(
    [
      "# Transcript Registry",
      "",
      "Public, machine-readable video transcripts.",
      "",
      `Search: ${origin}/search.txt?q=QUERY`,
      `Search JSON: ${origin}/search.json?q=QUERY`,
      "Search results include transcript videos and tracked YouTube channels.",
      "A zero-result search automatically queues local topic discovery.",
      `Discovery status: ${origin}/topics/JOB_ID.json`,
      "Poll the discovery status, then repeat the same search.",
      `Transcript HTML: ${origin}/youtube/VIDEO_ID`,
      `Transcript text: ${origin}/youtube/VIDEO_ID.txt`,
      `Transcript JSON: ${origin}/youtube/VIDEO_ID.json`,
      `Exact video on demand: ${origin}/on-demand.json?url=YOUTUBE_URL`,
      `Exact video on demand (text): ${origin}/on-demand.txt?url=YOUTUBE_URL`,
      "An on-demand miss returns HTTP 202 with a job URL. Poll it until complete, then open the transcript text URL.",
      `Submit missing video: POST ${origin}/api/add with {"url":"YOUTUBE_URL"}`,
      `Submit complete channel: POST ${origin}/api/channels with {"url":"YOUTUBE_CHANNEL_URL"}`,
      `Channel status: ${origin}/channels/CHANNEL_JOB_ID.json`,
      "Channel jobs enumerate all public uploads in batches and report progress plus ETA.",
      "",
      "Always cite both the transcript page and its original source URL.",
      "",
    ].join("\n"),
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
