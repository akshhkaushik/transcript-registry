import { getTopicJob } from "../../../../db/store";
import { jsonResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getTopicJob(id);
  if (!job) {
    return jsonResponse({ error: "Topic job not found" }, { status: 404 });
  }
  const origin = new URL(request.url).origin;
  return jsonResponse(
    {
      id: job.id,
      query: job.query,
      status: job.status,
      targetCount: job.targetCount,
      foundCount: job.foundCount,
      enqueuedCount: job.enqueuedCount,
      availableCount: job.availableCount,
      attempts: job.attempts,
      error: job.error,
      search: `${origin}/search.txt?q=${encodeURIComponent(job.query)}`,
      retryAfterSeconds:
        job.status === "queued" || job.status === "processing" ? 20 : null,
      updatedAt: job.updatedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
