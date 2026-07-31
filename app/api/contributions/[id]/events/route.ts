import {
  getJob,
  recordContributionJobEvent,
} from "../../../../../db/store";
import {
  contributionBearer,
  readContributionBody,
} from "../../../../../lib/contribution";
import { verifyContributionGrant } from "../../../../../lib/contribution-token";
import { jsonResponse } from "../../../../../lib/http";
import { parseContributionJobEvent } from "../../../../../lib/job-events";

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

  try {
    const payload = await readContributionBody(request);
    const result = await recordContributionJobEvent(
      id,
      grant.reservationId,
      parseContributionJobEvent(payload),
    );
    return jsonResponse(
      { status: "accepted", inserted: result.inserted, event: result.event },
      {
        status: result.inserted ? 202 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Invalid job event",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
