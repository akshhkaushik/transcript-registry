import {
  getJob,
  rotateContributionReservation,
} from "../../../../../db/store";
import {
  createContributionGrant,
  verifyContributionGrant,
} from "../../../../../lib/contribution-token";
import { contributionBearer } from "../../../../../lib/contribution";
import { jsonResponse } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return jsonResponse({ error: "Job not found" }, { status: 404 });
  const current = await verifyContributionGrant(contributionBearer(request), {
    jobId: id,
    videoId: job.providerId,
  });
  if (!current) {
    return jsonResponse(
      { error: "Contribution token is invalid or expired" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const next = await createContributionGrant({
    jobId: id,
    videoId: job.providerId,
  });
  await rotateContributionReservation(
    id,
    current.reservationId,
    next.reservationId,
  );
  return jsonResponse(
    { status: "ready", token: next.token, expiresAt: next.expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
