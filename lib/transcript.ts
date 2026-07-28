import type { TranscriptRecord, TranscriptSegment } from "./types";

export async function coerceTranscript(
  payload: unknown,
  expected?: { provider: "youtube"; providerId: string; sourceUrl: string },
): Promise<TranscriptRecord> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Transcript payload must be an object");
  }
  const input = payload as Record<string, unknown>;
  const provider = expected?.provider ?? readString(input.provider);
  const providerId = expected?.providerId ?? readString(input.providerId);
  if (provider !== "youtube" || !/^[A-Za-z0-9_-]{11}$/.test(providerId)) {
    throw new Error("Invalid YouTube transcript identity");
  }

  const transcriptText = readString(input.transcriptText).replace(/\s+/g, " ").trim();
  if (!transcriptText) throw new Error("Transcript text is required");
  const segments = readSegments(input.segments, transcriptText);
  const checksum = await sha256(
    `${provider}:${providerId}\n${transcriptText}\n${JSON.stringify(segments)}`,
  );
  const source = readString(input.transcriptSource) as TranscriptRecord["transcriptSource"];
  if (
    ![
      "creator-captions",
      "automatic-captions",
      "local-asr",
      "licensed-dataset",
    ].includes(source)
  ) {
    throw new Error("Invalid transcript source");
  }

  return {
    id: `${provider}:${providerId}`,
    provider,
    providerId,
    sourceUrl:
      expected?.sourceUrl ??
      readString(input.sourceUrl) ??
      `https://www.youtube.com/watch?v=${providerId}`,
    title: readString(input.title) || providerId,
    channel: readString(input.channel),
    channelUrl: optionalString(input.channelUrl),
    description: readString(input.description),
    publishedAt: optionalString(input.publishedAt),
    durationSeconds: optionalNumber(input.durationSeconds),
    language: readString(input.language) || "en",
    transcriptSource: source,
    license: readString(input.license) || "unknown",
    attribution: readString(input.attribution),
    topics: Array.isArray(input.topics)
      ? input.topics.map(readString).filter(Boolean).slice(0, 20)
      : [],
    transcriptText,
    segments,
    wordCount: transcriptText.split(/\s+/).length,
    checksum,
  };
}

function readSegments(value: unknown, fallbackText: string): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    return [{ start: 0, end: null, text: fallbackText }];
  }
  const segments = value
    .map((item): TranscriptSegment | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const text = readString(row.text).replace(/\s+/g, " ").trim();
      if (!text) return null;
      return {
        start: Math.max(0, Number(row.start) || 0),
        end: row.end == null ? null : Math.max(0, Number(row.end) || 0),
        text,
      };
    })
    .filter((item): item is TranscriptSegment => item !== null);
  return segments.length ? segments : [{ start: 0, end: null, text: fallbackText }];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | null {
  const result = readString(value);
  return result || null;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
