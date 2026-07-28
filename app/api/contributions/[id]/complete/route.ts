import { completeJob, getJob, getTranscript } from "../../../../../db/store";
import {
  contributionBearer,
  readContributionBody,
  validateContributedTranscript,
  verifiedYoutubeIdentity,
} from "../../../../../lib/contribution";
import { verifyContributionGrant } from "../../../../../lib/contribution-token";
import { jsonResponse } from "../../../../../lib/http";
import { coerceTranscript } from "../../../../../lib/transcript";

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

  const existing = await getTranscript(job.provider, job.providerId);
  if (existing) {
    return jsonResponse({
      status: "complete",
      transcript: `/youtube/${job.providerId}`,
      reused: true,
    });
  }

  try {
    const payload = await readContributionBody(request);
    const coerced = await coerceTranscript(payload, {
      provider: job.provider,
      providerId: job.providerId,
      sourceUrl: job.sourceUrl,
    });
    const transcript = validateContributedTranscript(coerced, payload);
    const identity = await verifiedYoutubeIdentity(job.providerId);
    await completeJob(
      id,
      {
        ...transcript,
        title: identity.title,
        channel: identity.channel,
        channelUrl: identity.channelUrl,
        ingestionSource: "community-worker",
        attribution: `${identity.channel} — original source linked above.`,
      },
      typeof payload.processingSeconds === "number"
        ? payload.processingSeconds
        : undefined,
      { overwriteExisting: false },
    );
    return jsonResponse({
      status: "complete",
      transcript: `/youtube/${job.providerId}`,
      text: `/youtube/${job.providerId}.txt`,
      json: `/youtube/${job.providerId}.json`,
      contributed: true,
    });
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error ? error.message : "Invalid contribution",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
