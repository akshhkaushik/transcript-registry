import { getChannelProgress } from "../../../../db/store";
import { jsonResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const channel = await getChannelProgress(id);
  if (!channel) {
    return jsonResponse({ error: "Channel job not found" }, { status: 404 });
  }
  return jsonResponse(channel, {
    headers: { "Cache-Control": "no-store" },
  });
}
