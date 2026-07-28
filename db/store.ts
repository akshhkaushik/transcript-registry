import type {
  IngestionJob,
  TranscriptRecord,
  TranscriptSegment,
} from "../lib/types";
import { ensureDatabase, rawDb } from "./runtime";

type TranscriptRow = {
  id: string;
  provider: "youtube";
  provider_id: string;
  source_url: string;
  title: string;
  channel: string;
  channel_url: string | null;
  description: string;
  published_at: string | null;
  duration_seconds: number | null;
  language: string;
  transcript_source: TranscriptRecord["transcriptSource"];
  license: string;
  attribution: string;
  topics_json: string;
  transcript_text: string;
  segments_json: string;
  word_count: number;
  checksum: string;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  provider: "youtube";
  provider_id: string;
  source_url: string;
  status: IngestionJob["status"];
  attempts: number;
  worker_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "s",
  "the",
  "this",
  "to",
  "up",
  "what",
  "whats",
  "with",
  "yo",
  "you",
  "your",
]);

export async function getTranscript(
  provider: string,
  providerId: string,
): Promise<TranscriptRecord | null> {
  await ensureDatabase();
  const row = await rawDb()
    .prepare(
      "SELECT * FROM transcripts WHERE provider = ? AND provider_id = ? LIMIT 1",
    )
    .bind(provider, providerId)
    .first<TranscriptRow>();
  return row ? mapTranscript(row) : null;
}

export async function saveTranscript(
  transcript: TranscriptRecord,
): Promise<void> {
  await ensureDatabase();
  const clean = validateTranscript(transcript);
  await rawDb()
    .prepare(`
      INSERT INTO transcripts (
        id, provider, provider_id, source_url, title, channel, channel_url,
        description, published_at, duration_seconds, language,
        transcript_source, license, attribution, topics_json,
        transcript_text, segments_json, word_count, checksum, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, provider_id) DO UPDATE SET
        source_url = excluded.source_url,
        title = excluded.title,
        channel = excluded.channel,
        channel_url = excluded.channel_url,
        description = excluded.description,
        published_at = excluded.published_at,
        duration_seconds = excluded.duration_seconds,
        language = excluded.language,
        transcript_source = excluded.transcript_source,
        license = excluded.license,
        attribution = excluded.attribution,
        topics_json = excluded.topics_json,
        transcript_text = excluded.transcript_text,
        segments_json = excluded.segments_json,
        word_count = excluded.word_count,
        checksum = excluded.checksum,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      clean.id,
      clean.provider,
      clean.providerId,
      clean.sourceUrl,
      clean.title,
      clean.channel,
      clean.channelUrl,
      clean.description,
      clean.publishedAt,
      clean.durationSeconds,
      clean.language,
      clean.transcriptSource,
      clean.license,
      clean.attribution,
      JSON.stringify(clean.topics),
      clean.transcriptText,
      JSON.stringify(clean.segments),
      clean.wordCount,
      clean.checksum,
    )
    .run();
}

export async function createOrFindJob(input: {
  provider: "youtube";
  providerId: string;
  sourceUrl: string;
}): Promise<{ job: IngestionJob; created: boolean }> {
  await ensureDatabase();
  const existing = await rawDb()
    .prepare(
      "SELECT * FROM jobs WHERE provider = ? AND provider_id = ? LIMIT 1",
    )
    .bind(input.provider, input.providerId)
    .first<JobRow>();
  if (existing) return { job: mapJob(existing), created: false };

  const id = crypto.randomUUID();
  await rawDb()
    .prepare(
      "INSERT INTO jobs (id, provider, provider_id, source_url) VALUES (?, ?, ?, ?)",
    )
    .bind(id, input.provider, input.providerId, input.sourceUrl)
    .run();
  const job = await getJob(id);
  if (!job) throw new Error("Job was not created");
  return { job, created: true };
}

export async function getJob(id: string): Promise<IngestionJob | null> {
  await ensureDatabase();
  const row = await rawDb()
    .prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function claimJob(workerId: string): Promise<IngestionJob | null> {
  await ensureDatabase();
  const db = rawDb();
  await db
    .prepare(`
      UPDATE jobs
      SET status = 'queued', worker_id = NULL, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
        AND claimed_at < datetime('now', '-45 minutes')
        AND attempts < 3
    `)
    .run();
  const candidate = await db
    .prepare(
      "SELECT id FROM jobs WHERE status = 'queued' AND attempts < 3 ORDER BY created_at ASC LIMIT 1",
    )
    .first<{ id: string }>();
  if (!candidate) return null;

  const result = await db
    .prepare(`
      UPDATE jobs
      SET status = 'processing', worker_id = ?, attempts = attempts + 1,
          claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `)
    .bind(workerId, candidate.id)
    .run();
  if (!result.meta.changes) return null;
  return getJob(candidate.id);
}

export async function completeJob(
  id: string,
  transcript: TranscriptRecord,
): Promise<void> {
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  if (
    transcript.provider !== job.provider ||
    transcript.providerId !== job.providerId
  ) {
    throw new Error("Transcript does not match the claimed job");
  }
  await saveTranscript(transcript);
  await rawDb()
    .prepare(`
      UPDATE jobs
      SET status = 'complete', error = NULL, completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(id)
    .run();
}

export async function failJob(id: string, error: string): Promise<void> {
  await ensureDatabase();
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  const terminal = job.attempts >= 3;
  await rawDb()
    .prepare(`
      UPDATE jobs
      SET status = ?, error = ?, worker_id = NULL, claimed_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(terminal ? "failed" : "queued", error.slice(0, 1000), id)
    .run();
}

export async function searchTranscripts(
  rawQuery: string,
  limit = 10,
): Promise<Array<TranscriptRecord & { snippet: string }>> {
  await ensureDatabase();
  const tokens = meaningfulTokens(rawQuery);
  if (!tokens.length) return [];

  const conditions = tokens.map(
    () =>
      "instr(lower(title || ' ' || channel || ' ' || description || ' ' || topics_json || ' ' || transcript_text), ?) > 0",
  );
  const rows = await rawDb()
    .prepare(`
      SELECT * FROM transcripts
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .bind(...tokens, Math.max(1, Math.min(limit, 50)))
    .all<TranscriptRow>();

  return rows.results.map((row) => {
    const transcript = mapTranscript(row);
    return {
      ...transcript,
      snippet: makeSnippet(transcript.transcriptText, tokens),
    };
  });
}

export async function listTranscriptIds(): Promise<
  Array<{ providerId: string; updatedAt: string }>
> {
  await ensureDatabase();
  const rows = await rawDb()
    .prepare(
      "SELECT provider_id, updated_at FROM transcripts WHERE provider = 'youtube' ORDER BY updated_at DESC",
    )
    .all<{ provider_id: string; updated_at: string }>();
  return rows.results.map((row) => ({
    providerId: row.provider_id,
    updatedAt: row.updated_at,
  }));
}

export async function getCounts(): Promise<{
  transcripts: number;
  queued: number;
  processing: number;
}> {
  await ensureDatabase();
  const db = rawDb();
  const [transcripts, queued, processing] = await Promise.all([
    db.prepare("SELECT count(*) AS count FROM transcripts").first<{ count: number }>(),
    db
      .prepare("SELECT count(*) AS count FROM jobs WHERE status = 'queued'")
      .first<{ count: number }>(),
    db
      .prepare("SELECT count(*) AS count FROM jobs WHERE status = 'processing'")
      .first<{ count: number }>(),
  ]);
  return {
    transcripts: transcripts?.count ?? 0,
    queued: queued?.count ?? 0,
    processing: processing?.count ?? 0,
  };
}

export async function checkAndRecordSubmission(
  clientHash: string,
  maximum = 10,
): Promise<boolean> {
  await ensureDatabase();
  const db = rawDb();
  await db
    .prepare("DELETE FROM submission_events WHERE created_at < datetime('now', '-2 hours')")
    .run();
  const recent = await db
    .prepare(`
      SELECT count(*) AS count FROM submission_events
      WHERE client_hash = ? AND created_at >= datetime('now', '-1 hour')
    `)
    .bind(clientHash)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= maximum) return false;
  await db
    .prepare(
      "INSERT INTO submission_events (id, client_hash) VALUES (?, ?)",
    )
    .bind(crypto.randomUUID(), clientHash)
    .run();
  return true;
}

export function meaningfulTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[’']/g, "")
        .match(/[a-z0-9]+/g)
        ?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [],
    ),
  ].slice(0, 8);
}

function validateTranscript(value: TranscriptRecord): TranscriptRecord {
  const text = value.transcriptText.replace(/\s+/g, " ").trim();
  if (!text || text.length > 2_000_000) {
    throw new Error("Transcript text is empty or too large");
  }
  const segments = value.segments
    .map((segment) => ({
      start: Math.max(0, Number(segment.start) || 0),
      end:
        segment.end == null ? null : Math.max(0, Number(segment.end) || 0),
      text: segment.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((segment) => segment.text);
  if (!segments.length) {
    segments.push({ start: 0, end: value.durationSeconds, text });
  }
  return {
    ...value,
    id: `${value.provider}:${value.providerId}`,
    sourceUrl: `https://www.youtube.com/watch?v=${value.providerId}`,
    title: value.title.trim().slice(0, 500) || value.providerId,
    channel: value.channel.trim().slice(0, 500),
    description: value.description.trim().slice(0, 5000),
    topics: [...new Set(value.topics.map((topic) => topic.trim()).filter(Boolean))].slice(
      0,
      20,
    ),
    transcriptText: text,
    segments,
    wordCount: text.split(/\s+/).length,
  };
}

function mapTranscript(row: TranscriptRow): TranscriptRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.provider_id,
    sourceUrl: row.source_url,
    title: row.title,
    channel: row.channel,
    channelUrl: row.channel_url,
    description: row.description,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    language: row.language,
    transcriptSource: row.transcript_source,
    license: row.license,
    attribution: row.attribution,
    topics: safeJson<string[]>(row.topics_json, []),
    transcriptText: row.transcript_text,
    segments: safeJson<TranscriptSegment[]>(row.segments_json, []),
    wordCount: row.word_count,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: JobRow): IngestionJob {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.provider_id,
    sourceUrl: row.source_url,
    status: row.status,
    attempts: row.attempts,
    workerId: row.worker_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function makeSnippet(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  const positions = tokens
    .map((token) => lower.indexOf(token))
    .filter((position) => position >= 0);
  const center = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, center - 140);
  const end = Math.min(text.length, center + 320);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}
