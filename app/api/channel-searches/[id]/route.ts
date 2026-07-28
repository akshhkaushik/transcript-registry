import { getChannelSearchJob } from "../../../../db/store";
import { jsonResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getChannelSearchJob(id);
  if (!job) {
    return jsonResponse(
      { error: "Channel search job not found" },
      { status: 404 },
    );
  }
  return jsonResponse(job, {
    headers: { "Cache-Control": "no-store" },
  });
}
