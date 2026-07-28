import { completeJob, getJob } from "../../../../../db/store";
import { jsonResponse, workerAuthorized } from "../../../../../lib/http";
import { coerceTranscript } from "../../../../../lib/transcript";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return jsonResponse({ error: "Job not found" }, { status: 404 });
  try {
    const payload = (await request.json()) as {
      processingSeconds?: unknown;
    };
    const transcript = await coerceTranscript(payload, {
      provider: job.provider,
      providerId: job.providerId,
      sourceUrl: job.sourceUrl,
    });
    await completeJob(
      id,
      transcript,
      typeof payload.processingSeconds === "number"
        ? payload.processingSeconds
        : undefined,
    );
    return jsonResponse({
      status: "complete",
      transcript: `/youtube/${job.providerId}`,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Invalid transcript" },
      { status: 400 },
    );
  }
}
