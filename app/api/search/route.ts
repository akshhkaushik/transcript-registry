import {
  checkAndRecordSubmission,
  createOrRefreshTopicJob,
  getTopicJobForQuery,
  meaningfulTokens,
  searchChannels,
  searchTranscripts,
} from "../../../db/store";
import {
  clientHash,
  jsonResponse,
  textResponse,
} from "../../../lib/http";
import type { TopicJob } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.max(
    1,
    Math.min(
      Number.parseInt(url.searchParams.get("limit") ?? "10", 10) || 10,
      50,
    ),
  );
  const [results, channels] = query
    ? await Promise.all([
        searchTranscripts(query, limit),
        searchChannels(query, Math.min(limit, 25)),
      ])
    : [[], []];
  const discovery = await discoveryForMiss(request, query, results.length);
  const body = {
    query,
    count: results.length,
    channelCount: channels.length,
    results: results.map((result) => ({
      provider: result.provider,
      videoId: result.providerId,
      title: result.title,
      channel: result.channel,
      source: result.sourceUrl,
      transcript: `/youtube/${result.providerId}`,
      text: `/youtube/${result.providerId}.txt`,
      snippet: result.snippet,
    })),
    channels: channels.map((channel) => ({
      id: channel.id,
      name:
        channel.channelName ||
        channel.normalizedUrl.split("/").filter(Boolean).at(-1) ||
        "YouTube channel",
      source: channel.channelUrl ?? channel.normalizedUrl,
      status: channel.status,
      progress: {
        discovered: channel.discoveredVideos,
        complete: channel.completedVideos,
        failed: channel.failedVideos,
        queued: channel.queuedVideos,
        processing: channel.processingVideos,
        percent: channel.progressPercent,
      },
      transcriptCoverage: {
        complete: channel.completedVideos,
        total: channel.reportedVideoCount ?? channel.discoveredVideos,
        percent: channel.transcriptCoveragePercent,
        fullyCovered: channel.fullyCovered,
      },
      failureReasons: channel.failureReasons,
      page: `/channels/${channel.id}`,
      json: `/channels/${channel.id}.json`,
    })),
    discovery:
      discovery && "job" in discovery
        ? {
            id: discovery.job.id,
            status: discovery.job.status,
            statusUrl: `/topics/${discovery.job.id}.json`,
            retryAfterSeconds: 20,
          }
        : discovery,
  };

  if (url.searchParams.get("format") === "txt") {
    const lines = [
      `Query: ${query}`,
      `Results: ${results.length}`,
      `Channels: ${channels.length}`,
      "",
    ];
    for (const [index, result] of results.entries()) {
      lines.push(
        `${index + 1}. ${result.title}`,
        `Channel: ${result.channel}`,
        `Transcript: ${url.origin}/youtube/${result.providerId}.txt`,
        `Source: ${result.sourceUrl}`,
        `Match: ${result.snippet}`,
        "",
      );
    }
    for (const [index, channel] of channels.entries()) {
      lines.push(
        `Channel ${index + 1}: ${channel.channelName || channel.normalizedUrl}`,
        `Status: ${channel.status}`,
        `Transcript coverage: ${channel.completedVideos}/${channel.reportedVideoCount ?? channel.discoveredVideos} (${channel.transcriptCoveragePercent}%)`,
        `Workflow completion: ${channel.progressPercent}%`,
        ...(channel.failureReasons.length
          ? [
              `Failures: ${channel.failureReasons
                .map((failure) => `${failure.count}× ${failure.reason}`)
                .join("; ")}`,
            ]
          : []),
        `Channel page: ${url.origin}/channels/${channel.id}`,
        `Channel status: ${url.origin}/channels/${channel.id}.json`,
        `YouTube: ${channel.channelUrl ?? channel.normalizedUrl}`,
        "",
      );
    }
    if (discovery && "job" in discovery) {
      lines.push(
        `Discovery: ${discovery.job.status}`,
        `Discovery job: ${url.origin}/topics/${discovery.job.id}.json`,
        `Retry search: ${url.origin}/search.txt?q=${encodeURIComponent(query)}`,
        "",
      );
    } else if (discovery?.status === "rate-limited") {
      lines.push(
        "Discovery: rate-limited",
        "Retry this search later.",
        "",
      );
    }
    return textResponse(`${lines.join("\n")}\n`, {
      headers: {
        "Cache-Control": results.length
          ? "public, max-age=60"
          : "no-store",
      },
    });
  }

  return jsonResponse(body, {
    headers: {
      "Cache-Control": results.length ? "public, max-age=60" : "no-store",
    },
  });
}

async function discoveryForMiss(
  request: Request,
  query: string,
  resultCount: number,
): Promise<
  | { job: TopicJob }
  | { status: "rate-limited" }
  | null
> {
  const url = new URL(request.url);
  if (
    resultCount > 0 ||
    url.searchParams.get("discover") === "0" ||
    !meaningfulTokens(query).length ||
    query.length > 200
  ) {
    return null;
  }
  const existing = await getTopicJobForQuery(query);
  if (existing) return { job: existing };
  if (
    !(await checkAndRecordSubmission(
      await clientHash(request),
      20,
    ))
  ) {
    return { status: "rate-limited" };
  }
  const { job } = await createOrRefreshTopicJob(query);
  return { job };
}
