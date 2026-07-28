import { failJob } from "../../../../../db/store";
import { jsonResponse, workerAuthorized } from "../../../../../lib/http";

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
    processingSeconds?: unknown;
  };
  try {
    await failJob(
      id,
      typeof body.error === "string" ? body.error : "Worker failed",
      typeof body.processingSeconds === "number"
        ? body.processingSeconds
        : undefined,
    );
    return jsonResponse({ status: "recorded" });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Job not found" },
      { status: 404 },
    );
  }
}
