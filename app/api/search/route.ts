import { searchTranscripts } from "../../../db/store";
import { jsonResponse, textResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const results = query ? await searchTranscripts(query) : [];
  const body = {
    query,
    count: results.length,
    results: results.map((result) => ({
      provider: result.provider,
      videoId: result.providerId,
      title: result.title,
      channel: result.channel,
      source: result.sourceUrl,
      transcript: `/youtube/${result.providerId}`,
      text: `/youtube/${result.providerId}.txt`,
      snippet: result.snippet,
    })),
  };

  if (url.searchParams.get("format") === "txt") {
    const lines = [`Query: ${query}`, `Results: ${results.length}`, ""];
    for (const [index, result] of results.entries()) {
      lines.push(
        `${index + 1}. ${result.title}`,
        `Channel: ${result.channel}`,
        `Transcript: ${url.origin}/youtube/${result.providerId}.txt`,
        `Source: ${result.sourceUrl}`,
        `Match: ${result.snippet}`,
        "",
      );
    }
    return textResponse(`${lines.join("\n")}\n`, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  return jsonResponse(body, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
