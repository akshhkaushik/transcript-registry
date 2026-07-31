import { getJob, listJobEvents } from "../../../../../db/store";
import { jsonResponse } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return jsonResponse({ error: "Job not found" }, { status: 404 });
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const events = await listJobEvents(
    id,
    Number.isFinite(after) ? after : 0,
    Number.isFinite(limit) ? limit : 100,
  );
  return jsonResponse(
    {
      jobId: id,
      events,
      cursor: events.at(-1)?.sequence ?? Math.max(0, Math.floor(after || 0)),
      terminal: job.status === "complete" || job.status === "failed",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
