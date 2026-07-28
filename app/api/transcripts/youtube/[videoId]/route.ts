import { getTranscript } from "../../../../../db/store";
import {
  jsonResponse,
  textResponse,
  transcriptAsText,
} from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  const { videoId } = await context.params;
  const format = new URL(request.url).searchParams.get("format");
  return transcriptResponse(videoId, format);
}

export async function transcriptResponse(
  videoId: string,
  format: string | null,
): Promise<Response> {
  const transcript = await getTranscript("youtube", videoId);
  if (!transcript) {
    return jsonResponse({ error: "Transcript not found" }, { status: 404 });
  }
  const cache = {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    Link: `</youtube/${videoId}>; rel="canonical"`,
  };
  if (format === "txt") {
    return textResponse(transcriptAsText(transcript), { headers: cache });
  }
  return jsonResponse(transcript, { headers: cache });
}
