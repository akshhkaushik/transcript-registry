import { getJob } from "../../../../db/store";
import { jsonResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return jsonResponse({ error: "Job not found" }, { status: 404 });
  return jsonResponse({
    ...job,
    transcript:
      job.status === "complete" ? `/youtube/${job.providerId}` : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
