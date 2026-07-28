import { failChannelSearchJob } from "../../../../../../db/store";
import {
  jsonResponse,
  workerAuthorized,
} from "../../../../../../lib/http";

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
    error?: unknown;
  } | null;
  await failChannelSearchJob(
    id,
    typeof body?.error === "string" ? body.error : "Channel search failed",
  );
  return jsonResponse({ status: "recorded" });
}
