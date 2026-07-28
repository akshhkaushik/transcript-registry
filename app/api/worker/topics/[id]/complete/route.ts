import {
  completeTopicJob,
  createOrFindJob,
  getTopicJob,
  getTranscript,
} from "../../../../../../db/store";
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
  const topicJob = await getTopicJob(id);
  if (!topicJob) {
    return jsonResponse({ error: "Topic job not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    videoUrls?: unknown;
  } | null;
  if (!body || !Array.isArray(body.videoUrls) || body.videoUrls.length > 25) {
    return jsonResponse(
      { error: "Send an array of at most 25 YouTube video URLs" },
      { status: 400 },
    );
  }

  const sources = [
    ...new Map(
      body.videoUrls
        .filter((value): value is string => typeof value === "string")
        .map(resolveSource)
        .filter((source) => source !== null)
        .map((source) => [source.providerId, source]),
    ).values(),
  ].slice(0, topicJob.targetCount);
  let available = 0;
  let enqueued = 0;
  await Promise.all(
    sources.map(async (source) => {
      const transcript = await getTranscript(
        source.provider,
        source.providerId,
      );
      if (transcript) {
        available += 1;
        return;
      }
      const result = await createOrFindJob({
        provider: source.provider,
        providerId: source.providerId,
        sourceUrl: source.canonicalUrl,
      });
      if (result.created) enqueued += 1;
    }),
  );
  await completeTopicJob(id, {
    found: sources.length,
    available,
    enqueued,
  });
  return jsonResponse({
    status: "complete",
    found: sources.length,
    available,
    enqueued,
    search: `/search.txt?q=${encodeURIComponent(topicJob.query)}`,
  });
}
