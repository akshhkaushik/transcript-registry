import { failTopicJob } from "../../../../../../db/store";
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
  const body = (await request.json().catch(() => ({}))) as {
    error?: unknown;
  };
  try {
    await failTopicJob(
      id,
      typeof body.error === "string" ? body.error : "Topic discovery failed",
    );
    return jsonResponse({ status: "recorded" });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Topic job not found" },
      { status: 404 },
    );
  }
}
