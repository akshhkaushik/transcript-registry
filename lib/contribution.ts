import type { TranscriptRecord } from "./types";

const MAX_BODY_BYTES = 3_000_000;
const MAX_SEGMENTS = 50_000;
const MAX_SECONDS = 48 * 60 * 60;

export function contributionBearer(request: Request): string {
  return (
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ??
    ""
  );
}

export async function readContributionBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new Error("Contribution payload is too large");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new Error("Contribution payload is too large");
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contribution payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function validateContributedTranscript(
  transcript: TranscriptRecord,
  payload: Record<string, unknown>,
): TranscriptRecord {
  if (
    !["creator-captions", "automatic-captions", "local-asr"].includes(
      transcript.transcriptSource,
    )
  ) {
    throw new Error("Unsupported contribution transcript source");
  }
  if (transcript.segments.length > MAX_SEGMENTS) {
    throw new Error("Contribution contains too many timestamp segments");
  }
  if (transcript.durationSeconds != null && transcript.durationSeconds > MAX_SECONDS) {
    throw new Error("Video duration exceeds the contribution limit");
  }

  let previousStart = -1;
  for (const segment of transcript.segments) {
    if (
      !Number.isFinite(segment.start) ||
      segment.start < previousStart ||
      segment.start > MAX_SECONDS ||
      (segment.end != null &&
        (!Number.isFinite(segment.end) ||
          segment.end < segment.start ||
          segment.end > MAX_SECONDS))
    ) {
      throw new Error("Transcript timestamps must be ordered and valid");
    }
    previousStart = segment.start;
  }

  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const joined = normalize(
    transcript.segments.map((segment) => segment.text).join(" "),
  );
  if (joined !== normalize(transcript.transcriptText)) {
    throw new Error("Transcript text must match the timestamped segments");
  }
  if (
    transcript.transcriptSource === "local-asr" &&
    payload.rightsConfirmed !== true
  ) {
    throw new Error(
      "Local ASR contributions require confirmation that transcription is permitted",
    );
  }
  return transcript;
}

export async function verifiedYoutubeIdentity(
  videoId: string,
): Promise<{ title: string; channel: string; channelUrl: string | null }> {
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "transcript-registry/1.0" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`YouTube could not verify this video (${response.status})`);
  }
  const body = (await response.json()) as {
    title?: unknown;
    author_name?: unknown;
    author_url?: unknown;
  };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const channel =
    typeof body.author_name === "string" ? body.author_name.trim() : "";
  const channelUrl =
    typeof body.author_url === "string" && body.author_url.startsWith("https://")
      ? body.author_url
      : null;
  if (!title || !channel) {
    throw new Error("YouTube returned incomplete video metadata");
  }
  return { title, channel, channelUrl };
}
