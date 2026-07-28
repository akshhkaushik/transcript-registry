import { getJob, releaseContributionJob } from "../../../../../db/store";
import {
  contributionBearer,
  readContributionBody,
} from "../../../../../lib/contribution";
import { verifyContributionGrant } from "../../../../../lib/contribution-token";
import { jsonResponse } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return jsonResponse({ error: "Job not found" }, { status: 404 });
  const grant = await verifyContributionGrant(contributionBearer(request), {
    jobId: id,
    videoId: job.providerId,
  });
  if (!grant) {
    return jsonResponse(
      { error: "Contribution token is invalid or expired" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (job.status === "complete") {
    return jsonResponse({ status: "complete" });
  }

  const payload: Record<string, unknown> = await readContributionBody(
    request,
  ).catch(() => ({}));
  const error =
    typeof payload.error === "string"
      ? `Local contributor released job: ${payload.error}`
      : "Local contributor released job";
  const released = await releaseContributionJob(
    id,
    grant.reservationId,
    error,
  );
  return jsonResponse(
    { status: released.status, released: released.status === "queued" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
