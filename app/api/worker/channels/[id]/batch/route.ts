import { ingestChannelBatch } from "../../../../../../db/store";
import {
  jsonResponse,
  workerAuthorized,
} from "../../../../../../lib/http";
import { resolveSource } from "../../../../../../lib/youtube";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    channelId?: unknown;
    channelName?: unknown;
    channelUrl?: unknown;
    reportedVideoCount?: unknown;
    videos?: unknown;
  } | null;
  if (!body || !Array.isArray(body.videos) || body.videos.length > 100) {
    return jsonResponse(
      { error: "Send an array of at most 100 videos" },
      { status: 400 },
    );
  }
  const videos = body.videos
    .map((value) => {
      const item =
        typeof value === "string"
          ? { url: value, title: "" }
          : (value as { url?: unknown; title?: unknown });
      const source =
        typeof item?.url === "string" ? resolveSource(item.url) : null;
      return source
        ? {
            providerId: source.providerId,
            sourceUrl: source.canonicalUrl,
            title: typeof item.title === "string" ? item.title : "",
          }
        : null;
    })
    .filter((video) => video !== null);
  try {
    const result = await ingestChannelBatch(id, {
      channelId:
        typeof body.channelId === "string" ? body.channelId : undefined,
      channelName:
        typeof body.channelName === "string" ? body.channelName : undefined,
      channelUrl:
        typeof body.channelUrl === "string" ? body.channelUrl : undefined,
      reportedVideoCount:
        typeof body.reportedVideoCount === "number"
          ? body.reportedVideoCount
          : undefined,
      videos,
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Batch failed" },
      { status: 400 },
    );
  }
}
