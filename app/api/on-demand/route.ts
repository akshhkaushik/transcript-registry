import {
  checkAndRecordSubmission,
  createOrFindJob,
  getTranscript,
} from "../../../db/store";
import {
  clientHash,
  jsonResponse,
  textResponse,
} from "../../../lib/http";
import { resolveSource } from "../../../lib/youtube";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return serviceTranscript(
    request,
    url.searchParams.get("url") ?? url.searchParams.get("video") ?? "",
  );
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let input = "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      video?: unknown;
    } | null;
    input =
      typeof body?.url === "string"
        ? body.url
        : typeof body?.video === "string"
          ? body.video
          : "";
  } else {
    const form = await request.formData();
    input = String(form.get("url") ?? form.get("video") ?? "");
  }
  return serviceTranscript(request, input);
}

async function serviceTranscript(
  request: Request,
  input: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const source = resolveSource(input);
  if (!source) {
    return output(
      requestUrl,
      {
        status: "invalid",
        error: "Enter a valid YouTube video URL or 11-character video ID.",
      },
      400,
    );
  }

  const paths = transcriptPaths(requestUrl.origin, source.providerId);
  const transcript = await getTranscript(source.provider, source.providerId);
  if (transcript) {
    return output(
      requestUrl,
      {
        status: "complete",
        videoId: source.providerId,
        title: transcript.title,
        channel: transcript.channel,
        source: transcript.sourceUrl,
        ...paths,
      },
      200,
    );
  }

  if (!(await checkAndRecordSubmission(await clientHash(request), 20))) {
    return output(
      requestUrl,
      {
        status: "rate-limited",
        error: "On-demand submission limit reached. Try again later.",
      },
      429,
    );
  }

  const { job, created } = await createOrFindJob({
    provider: source.provider,
    providerId: source.providerId,
    sourceUrl: source.canonicalUrl,
  });
  const jobUrl = `${requestUrl.origin}/jobs/${job.id}.json`;
  if (job.status === "complete") {
    return output(
      requestUrl,
      {
        status: "complete",
        videoId: source.providerId,
        source: source.canonicalUrl,
        ...paths,
      },
      200,
    );
  }
  if (job.status === "failed") {
    return output(
      requestUrl,
      {
        status: "failed",
        videoId: source.providerId,
        source: source.canonicalUrl,
        job: jobUrl,
        error: job.error,
      },
      200,
    );
  }
  return output(
    requestUrl,
    {
      status: job.status,
      created,
      videoId: source.providerId,
      source: source.canonicalUrl,
      job: jobUrl,
      retryAfterSeconds: 15,
      afterCompletion: paths,
    },
    202,
    { "Retry-After": "15", Location: jobUrl },
  );
}

function transcriptPaths(origin: string, videoId: string) {
  return {
    transcript: `${origin}/youtube/${videoId}`,
    text: `${origin}/youtube/${videoId}.txt`,
    json: `${origin}/youtube/${videoId}.json`,
  };
}

function output(
  url: URL,
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const cacheHeaders = {
    "Cache-Control": body.status === "complete" ? "public, max-age=60" : "no-store",
    ...headers,
  };
  if (url.searchParams.get("format") !== "txt") {
    return jsonResponse(body, { status, headers: cacheHeaders });
  }
  const lines = Object.entries(body).flatMap(([key, value]) => {
    if (value == null) return [];
    if (typeof value === "object") {
      return Object.entries(value).map(
        ([nestedKey, nestedValue]) =>
          `${label(nestedKey)}: ${String(nestedValue)}`,
      );
    }
    return [`${label(key)}: ${String(value)}`];
  });
  return textResponse(`${lines.join("\n")}\n`, {
    status,
    headers: cacheHeaders,
  });
}

function label(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
