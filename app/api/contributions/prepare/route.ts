import {
  checkAndRecordSubmission,
  createOrFindJob,
  getTranscript,
  reserveJobForContribution,
} from "../../../../db/store";
import {
  contributionWorkerId,
  createContributionGrant,
} from "../../../../lib/contribution-token";
import { clientHash, jsonResponse } from "../../../../lib/http";
import { resolveSource } from "../../../../lib/youtube";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    video?: unknown;
  } | null;
  const input =
    typeof body?.url === "string"
      ? body.url
      : typeof body?.video === "string"
        ? body.video
        : "";
  const source = resolveSource(input);
  if (!source) {
    return jsonResponse(
      {
        status: "invalid",
        error: "Enter a valid YouTube video URL or 11-character video ID.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const paths = transcriptPaths(requestUrl.origin, source.providerId);
  const existing = await getTranscript(source.provider, source.providerId);
  if (existing) {
    return jsonResponse(
      {
        status: "complete",
        videoId: source.providerId,
        title: existing.title,
        channel: existing.channel,
        ...paths,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  if (!(await checkAndRecordSubmission(await clientHash(request), 20))) {
    return jsonResponse(
      {
        status: "rate-limited",
        error: "Local contribution limit reached. Try again later.",
      },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { job, created } = await createOrFindJob({
    provider: source.provider,
    providerId: source.providerId,
    sourceUrl: source.canonicalUrl,
  });
  const grant = await createContributionGrant({
    jobId: job.id,
    videoId: source.providerId,
  });
  const reservation = await reserveJobForContribution(
    job.id,
    contributionWorkerId(grant.reservationId),
  );

  if (reservation.job.status === "complete") {
    return jsonResponse(
      {
        status: "complete",
        videoId: source.providerId,
        ...paths,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  return jsonResponse(
    {
      status: "ready",
      created,
      reserved: reservation.reserved,
      videoId: source.providerId,
      source: source.canonicalUrl,
      jobId: job.id,
      token: grant.token,
      expiresAt: grant.expiresAt,
      upload: `${requestUrl.origin}/api/contributions/${job.id}/complete`,
      release: `${requestUrl.origin}/api/contributions/${job.id}/release`,
      afterCompletion: paths,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

function transcriptPaths(origin: string, videoId: string) {
  return {
    transcript: `${origin}/youtube/${videoId}`,
    text: `${origin}/youtube/${videoId}.txt`,
    json: `${origin}/youtube/${videoId}.json`,
  };
}
