import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  lt,
  sql,
} from "drizzle-orm";
import type {
  IngestionJob,
  TopicJob,
  TranscriptRecord,
  TranscriptSegment,
} from "../lib/types";
import { getDb } from "./index";
import { jobs, submissionEvents, topicJobs, transcripts } from "./schema";
import { ensureDatabase } from "./runtime";

type TranscriptRow = typeof transcripts.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type TopicJobRow = typeof topicJobs.$inferSelect;

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
  const [row] = await getDb()
    .select()
    .from(transcripts)
    .where(
      and(
        eq(transcripts.provider, provider),
        eq(transcripts.providerId, providerId),
      ),
    )
    .limit(1);
  return row ? mapTranscript(row) : null;
}

export async function saveTranscript(
  transcript: TranscriptRecord,
): Promise<void> {
  await saveTranscripts([transcript]);
}

export async function saveTranscripts(
  values: TranscriptRecord[],
): Promise<void> {
  await ensureDatabase();
  if (!values.length) return;

  const rows = values.map((value) => {
    const clean = validateTranscript(value);
    return {
      id: clean.id,
      provider: clean.provider,
      providerId: clean.providerId,
      sourceUrl: clean.sourceUrl,
      title: clean.title,
      channel: clean.channel,
      channelUrl: clean.channelUrl,
      description: clean.description,
      publishedAt: clean.publishedAt,
      durationSeconds: clean.durationSeconds,
      language: clean.language,
      transcriptSource: clean.transcriptSource,
      license: clean.license,
      attribution: clean.attribution,
      topicsJson: JSON.stringify(clean.topics),
      transcriptText: clean.transcriptText,
      segmentsJson: JSON.stringify(clean.segments),
      wordCount: clean.wordCount,
      checksum: clean.checksum,
    };
  });

  await getDb()
    .insert(transcripts)
    .values(rows)
    .onConflictDoUpdate({
      target: [transcripts.provider, transcripts.providerId],
      set: {
        sourceUrl: sql`excluded.source_url`,
        title: sql`excluded.title`,
        channel: sql`excluded.channel`,
        channelUrl: sql`excluded.channel_url`,
        description: sql`excluded.description`,
        publishedAt: sql`excluded.published_at`,
        durationSeconds: sql`excluded.duration_seconds`,
        language: sql`excluded.language`,
        transcriptSource: sql`excluded.transcript_source`,
        license: sql`excluded.license`,
        attribution: sql`excluded.attribution`,
        topicsJson: sql`excluded.topics_json`,
        transcriptText: sql`excluded.transcript_text`,
        segmentsJson: sql`excluded.segments_json`,
        wordCount: sql`excluded.word_count`,
        checksum: sql`excluded.checksum`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}

export async function createOrFindJob(input: {
  provider: "youtube";
  providerId: string;
  sourceUrl: string;
}): Promise<{ job: IngestionJob; created: boolean }> {
  await ensureDatabase();
  const id = crypto.randomUUID();
  const [created] = await getDb()
    .insert(jobs)
    .values({
      id,
      provider: input.provider,
      providerId: input.providerId,
      sourceUrl: input.sourceUrl,
    })
    .onConflictDoNothing({
      target: [jobs.provider, jobs.providerId],
    })
    .returning();

  if (created) return { job: mapJob(created), created: true };

  const [existing] = await getDb()
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.provider, input.provider),
        eq(jobs.providerId, input.providerId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Job was not created");
  return { job: mapJob(existing), created: false };
}

export async function getJob(id: string): Promise<IngestionJob | null> {
  await ensureDatabase();
  const [row] = await getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  return row ? mapJob(row) : null;
}

export async function claimJob(workerId: string): Promise<IngestionJob | null> {
  await ensureDatabase();
  const database = getDb();
  const staleBefore = new Date(Date.now() - 45 * 60 * 1000).toISOString();

  await database
    .update(jobs)
    .set({
      status: "queued",
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(jobs.status, "processing"),
        lt(jobs.claimedAt, staleBefore),
        lt(jobs.attempts, 3),
      ),
    );

  const [candidate] = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lt(jobs.attempts, 3)))
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  if (!candidate) return null;

  const [claimed] = await database
    .update(jobs)
    .set({
      status: "processing",
      workerId,
      attempts: sql`${jobs.attempts} + 1`,
      claimedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
    .returning();
  return claimed ? mapJob(claimed) : null;
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
  await getDb()
    .update(jobs)
    .set({
      status: "complete",
      error: null,
      completedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(jobs.id, id));
}

export async function failJob(id: string, error: string): Promise<void> {
  await ensureDatabase();
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  await getDb()
    .update(jobs)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      error: error.slice(0, 1000),
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(jobs.id, id));
}

export async function getTopicJob(id: string): Promise<TopicJob | null> {
  await ensureDatabase();
  const [row] = await getDb()
    .select()
    .from(topicJobs)
    .where(eq(topicJobs.id, id))
    .limit(1);
  return row ? mapTopicJob(row) : null;
}

export async function getTopicJobForQuery(
  query: string,
): Promise<TopicJob | null> {
  await ensureDatabase();
  const normalizedQuery = normalizeTopicQuery(query);
  if (!normalizedQuery) return null;
  const [row] = await getDb()
    .select()
    .from(topicJobs)
    .where(eq(topicJobs.normalizedQuery, normalizedQuery))
    .limit(1);
  return row ? mapTopicJob(row) : null;
}

export async function createOrRefreshTopicJob(
  query: string,
  targetCount = 8,
  force = false,
): Promise<{ job: TopicJob; created: boolean; refreshed: boolean }> {
  await ensureDatabase();
  const cleanQuery = query.replace(/\s+/g, " ").trim().slice(0, 200);
  const normalizedQuery = normalizeTopicQuery(cleanQuery);
  if (!normalizedQuery) throw new Error("Topic query is too broad or empty");
  const safeTarget = Math.max(1, Math.min(targetCount, 25));
  const database = getDb();
  const [created] = await database
    .insert(topicJobs)
    .values({
      id: crypto.randomUUID(),
      query: cleanQuery,
      normalizedQuery,
      targetCount: safeTarget,
    })
    .onConflictDoNothing({ target: topicJobs.normalizedQuery })
    .returning();
  if (created) {
    return { job: mapTopicJob(created), created: true, refreshed: false };
  }

  const existing = await getTopicJobForQuery(cleanQuery);
  if (!existing) throw new Error("Topic job was not created");
  const refreshBefore = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const staleComplete =
    existing.status === "complete" &&
    Date.parse(existing.updatedAt) < refreshBefore;
  const refreshable =
    existing.status === "failed" || staleComplete || force;
  if (!refreshable || existing.status === "processing") {
    return { job: existing, created: false, refreshed: false };
  }

  const [refreshed] = await database
    .update(topicJobs)
    .set({
      query: cleanQuery,
      status: "queued",
      targetCount: safeTarget,
      foundCount: 0,
      enqueuedCount: 0,
      availableCount: 0,
      attempts: 0,
      workerId: null,
      error: null,
      claimedAt: null,
      completedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(topicJobs.id, existing.id))
    .returning();
  if (!refreshed) throw new Error("Topic job was not refreshed");
  return { job: mapTopicJob(refreshed), created: false, refreshed: true };
}

export async function claimTopicJob(
  workerId: string,
): Promise<TopicJob | null> {
  await ensureDatabase();
  const database = getDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await database
    .update(topicJobs)
    .set({
      status: "queued",
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(topicJobs.status, "processing"),
        lt(topicJobs.claimedAt, staleBefore),
        lt(topicJobs.attempts, 3),
      ),
    );
  const [candidate] = await database
    .select({ id: topicJobs.id })
    .from(topicJobs)
    .where(and(eq(topicJobs.status, "queued"), lt(topicJobs.attempts, 3)))
    .orderBy(asc(topicJobs.createdAt))
    .limit(1);
  if (!candidate) return null;
  const [claimed] = await database
    .update(topicJobs)
    .set({
      status: "processing",
      workerId,
      attempts: sql`${topicJobs.attempts} + 1`,
      claimedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(eq(topicJobs.id, candidate.id), eq(topicJobs.status, "queued")),
    )
    .returning();
  return claimed ? mapTopicJob(claimed) : null;
}

export async function completeTopicJob(
  id: string,
  counts: {
    found: number;
    enqueued: number;
    available: number;
  },
): Promise<void> {
  await ensureDatabase();
  const [updated] = await getDb()
    .update(topicJobs)
    .set({
      status: "complete",
      foundCount: Math.max(0, counts.found),
      enqueuedCount: Math.max(0, counts.enqueued),
      availableCount: Math.max(0, counts.available),
      error: null,
      completedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(topicJobs.id, id))
    .returning({ id: topicJobs.id });
  if (!updated) throw new Error("Topic job not found");
}

export async function failTopicJob(
  id: string,
  error: string,
): Promise<void> {
  await ensureDatabase();
  const job = await getTopicJob(id);
  if (!job) throw new Error("Topic job not found");
  await getDb()
    .update(topicJobs)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      error: error.slice(0, 1000),
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(topicJobs.id, id));
}

export async function searchTranscripts(
  rawQuery: string,
  limit = 10,
): Promise<Array<TranscriptRecord & { snippet: string }>> {
  await ensureDatabase();
  const tokens = meaningfulTokens(rawQuery);
  if (!tokens.length) return [];
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const document = sql<string>`concat_ws(
    ' ',
    ${transcripts.title},
    ${transcripts.channel},
    ${transcripts.description},
    ${transcripts.topicsJson},
    ${transcripts.transcriptText}
  )`;
  const conditions = tokens.map(
    (token) => sql`${document} ILIKE ${`%${token}%`}`,
  );
  const rows = await getDb()
    .select()
    .from(transcripts)
    .where(and(...conditions))
    .orderBy(desc(transcripts.updatedAt))
    .limit(200);

  return rows
    .map((row) => {
      const transcript = mapTranscript(row);
      return {
        transcript,
        score: transcriptRelevance(transcript, tokens),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.transcript.updatedAt ?? "").localeCompare(
          left.transcript.updatedAt ?? "",
        ),
    )
    .slice(0, safeLimit)
    .map(({ transcript }) => ({
      ...transcript,
      snippet: makeSnippet(transcript.transcriptText, tokens),
    }));
}

export async function listTranscriptIds(): Promise<
  Array<{ providerId: string; updatedAt: string }>
> {
  await ensureDatabase();
  const rows = await getDb()
    .select({
      providerId: transcripts.providerId,
      updatedAt: transcripts.updatedAt,
    })
    .from(transcripts)
    .where(eq(transcripts.provider, "youtube"))
    .orderBy(desc(transcripts.updatedAt));
  return rows;
}

export async function getCounts(): Promise<{
  transcripts: number;
  queued: number;
  processing: number;
  topicQueued: number;
  topicProcessing: number;
}> {
  await ensureDatabase();
  const database = getDb();
  const [
    [transcriptCount],
    [queuedCount],
    [processingCount],
    [topicQueuedCount],
    [topicProcessingCount],
  ] =
    await Promise.all([
      database.select({ value: count() }).from(transcripts),
      database
        .select({ value: count() })
        .from(jobs)
        .where(eq(jobs.status, "queued")),
      database
        .select({ value: count() })
        .from(jobs)
        .where(eq(jobs.status, "processing")),
      database
        .select({ value: count() })
        .from(topicJobs)
        .where(eq(topicJobs.status, "queued")),
      database
        .select({ value: count() })
        .from(topicJobs)
        .where(eq(topicJobs.status, "processing")),
    ]);
  return {
    transcripts: transcriptCount?.value ?? 0,
    queued: queuedCount?.value ?? 0,
    processing: processingCount?.value ?? 0,
    topicQueued: topicQueuedCount?.value ?? 0,
    topicProcessing: topicProcessingCount?.value ?? 0,
  };
}

export async function checkAndRecordSubmission(
  clientHash: string,
  maximum = 10,
): Promise<boolean> {
  await ensureDatabase();
  const database = getDb();
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

  await database
    .delete(submissionEvents)
    .where(lt(submissionEvents.createdAt, twoHoursAgo));
  const [recent] = await database
    .select({ value: count() })
    .from(submissionEvents)
    .where(
      and(
        eq(submissionEvents.clientHash, clientHash),
        gte(submissionEvents.createdAt, oneHourAgo),
      ),
    );
  if ((recent?.value ?? 0) >= maximum) return false;
  await database.insert(submissionEvents).values({
    id: crypto.randomUUID(),
    clientHash,
  });
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

export function normalizeTopicQuery(query: string): string {
  return meaningfulTokens(query).join(" ");
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
    topics: [
      ...new Set(value.topics.map((topic) => topic.trim()).filter(Boolean)),
    ].slice(0, 20),
    transcriptText: text,
    segments,
    wordCount: text.split(/\s+/).length,
  };
}

function mapTranscript(row: TranscriptRow): TranscriptRecord {
  return {
    id: row.id,
    provider: row.provider as TranscriptRecord["provider"],
    providerId: row.providerId,
    sourceUrl: row.sourceUrl,
    title: row.title,
    channel: row.channel,
    channelUrl: row.channelUrl,
    description: row.description,
    publishedAt: row.publishedAt,
    durationSeconds: row.durationSeconds,
    language: row.language,
    transcriptSource:
      row.transcriptSource as TranscriptRecord["transcriptSource"],
    license: row.license,
    attribution: row.attribution,
    topics: safeJson<string[]>(row.topicsJson, []),
    transcriptText: row.transcriptText,
    segments: safeJson<TranscriptSegment[]>(row.segmentsJson, []),
    wordCount: row.wordCount,
    checksum: row.checksum,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapJob(row: JobRow): IngestionJob {
  return {
    id: row.id,
    provider: row.provider as IngestionJob["provider"],
    providerId: row.providerId,
    sourceUrl: row.sourceUrl,
    status: row.status as IngestionJob["status"],
    attempts: row.attempts,
    workerId: row.workerId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
  };
}

function mapTopicJob(row: TopicJobRow): TopicJob {
  return {
    id: row.id,
    query: row.query,
    normalizedQuery: row.normalizedQuery,
    status: row.status as TopicJob["status"],
    targetCount: row.targetCount,
    foundCount: row.foundCount,
    enqueuedCount: row.enqueuedCount,
    availableCount: row.availableCount,
    attempts: row.attempts,
    workerId: row.workerId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function transcriptRelevance(
  transcript: TranscriptRecord,
  tokens: string[],
): number {
  const phrase = tokens.join(" ");
  const title = transcript.title.toLowerCase();
  const channel = transcript.channel.toLowerCase();
  const topics = transcript.topics.join(" ").toLowerCase();
  const description = transcript.description.toLowerCase();
  const body = transcript.transcriptText.toLowerCase();

  let score = 0;
  if (phrase.length > 2 && title.includes(phrase)) score += 500;
  if (phrase.length > 2 && channel.includes(phrase)) score += 250;
  if (phrase.length > 2 && topics.includes(phrase)) score += 150;
  if (phrase.length > 2 && description.includes(phrase)) score += 75;
  if (phrase.length > 2 && body.includes(phrase)) score += 10;

  for (const token of tokens) {
    if (title.includes(token)) score += 100;
    if (channel.includes(token)) score += 50;
    if (topics.includes(token)) score += 30;
    if (description.includes(token)) score += 10;
    if (body.includes(token)) score += 1;
  }
  return score;
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
