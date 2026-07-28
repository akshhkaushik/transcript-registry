import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import type {
  ChannelJob,
  ChannelCandidate,
  ChannelProgress,
  ChannelSearchJob,
  IngestionJob,
  TopicJob,
  TranscriptRecord,
  TranscriptSegment,
} from "../lib/types";
import { getDb } from "./index";
import {
  channelJobs,
  channelSearchJobs,
  channelVideos,
  jobs,
  submissionEvents,
  topicJobs,
  transcripts,
} from "./schema";
import { ensureDatabase } from "./runtime";

type TranscriptRow = typeof transcripts.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type ChannelJobRow = typeof channelJobs.$inferSelect;
type ChannelSearchJobRow = typeof channelSearchJobs.$inferSelect;
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

export async function createOrRefreshChannelJob(
  input: {
    inputUrl: string;
    normalizedUrl: string;
  },
  options: {
    batchSize?: number;
    concurrency?: number;
    force?: boolean;
  } = {},
): Promise<{ job: ChannelProgress; created: boolean; refreshed: boolean }> {
  await ensureDatabase();
  const batchSize = Math.max(10, Math.min(options.batchSize ?? 50, 100));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const database = getDb();
  const [created] = await database
    .insert(channelJobs)
    .values({
      id: crypto.randomUUID(),
      inputUrl: input.inputUrl,
      normalizedUrl: input.normalizedUrl,
      batchSize,
      concurrency,
    })
    .onConflictDoNothing({ target: channelJobs.normalizedUrl })
    .returning();
  if (created) {
    return {
      job: await getChannelProgress(created.id).then(requiredChannel),
      created: true,
      refreshed: false,
    };
  }

  const [existing] = await database
    .select()
    .from(channelJobs)
    .where(eq(channelJobs.normalizedUrl, input.normalizedUrl))
    .limit(1);
  if (!existing) throw new Error("Channel job was not created");
  const active = ["queued", "discovering", "processing"].includes(
    existing.status,
  );
  const recentlyCompleted =
    existing.status === "complete" &&
    Date.parse(existing.updatedAt) > Date.now() - 6 * 60 * 60 * 1000;
  if (active || (recentlyCompleted && !options.force)) {
    return {
      job: await getChannelProgress(existing.id).then(requiredChannel),
      created: false,
      refreshed: false,
    };
  }

  await database
    .update(channelJobs)
    .set({
      inputUrl: input.inputUrl,
      status: "queued",
      batchSize,
      concurrency,
      batchesReceived: 0,
      attempts: 0,
      workerId: null,
      error: null,
      claimedAt: null,
      discoveryCompletedAt: null,
      completedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelJobs.id, existing.id));
  return {
    job: await getChannelProgress(existing.id).then(requiredChannel),
    created: false,
    refreshed: true,
  };
}

export async function claimChannelJob(
  workerId: string,
): Promise<ChannelJob | null> {
  await ensureDatabase();
  const database = getDb();
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await database
    .update(channelJobs)
    .set({
      status: "queued",
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(channelJobs.status, "discovering"),
        lt(channelJobs.claimedAt, staleBefore),
        lt(channelJobs.attempts, 3),
      ),
    );
  const [candidate] = await database
    .select({ id: channelJobs.id })
    .from(channelJobs)
    .where(and(eq(channelJobs.status, "queued"), lt(channelJobs.attempts, 3)))
    .orderBy(asc(channelJobs.createdAt))
    .limit(1);
  if (!candidate) return null;
  const [claimed] = await database
    .update(channelJobs)
    .set({
      status: "discovering",
      workerId,
      attempts: sql`${channelJobs.attempts} + 1`,
      claimedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(channelJobs.id, candidate.id),
        eq(channelJobs.status, "queued"),
      ),
    )
    .returning();
  return claimed ? mapChannelJob(claimed) : null;
}

export async function ingestChannelBatch(
  id: string,
  input: {
    channelId?: string;
    channelName?: string;
    channelUrl?: string;
    reportedVideoCount?: number;
    videos: Array<{
      providerId: string;
      sourceUrl: string;
      title?: string;
    }>;
  },
): Promise<{
  received: number;
  inserted: number;
  alreadyAvailable: number;
  queued: number;
}> {
  await ensureDatabase();
  const database = getDb();
  const [channel] = await database
    .select({ id: channelJobs.id })
    .from(channelJobs)
    .where(eq(channelJobs.id, id))
    .limit(1);
  if (!channel) throw new Error("Channel job not found");
  const sources = [
    ...new Map(
      input.videos.map((video) => [video.providerId, video]),
    ).values(),
  ].slice(0, 100);
  if (!sources.length) {
    await updateChannelMetadata(id, input, false);
    return { received: 0, inserted: 0, alreadyAvailable: 0, queued: 0 };
  }
  const providerIds = sources.map((source) => source.providerId);
  const existingRows = await database
    .select({ providerId: channelVideos.providerId })
    .from(channelVideos)
    .where(
      and(
        eq(channelVideos.channelJobId, id),
        inArray(channelVideos.providerId, providerIds),
      ),
    );
  const existingIds = new Set(existingRows.map((row) => row.providerId));
  const newSources = sources.filter(
    (source) => !existingIds.has(source.providerId),
  );
  if (!newSources.length) {
    await updateChannelMetadata(id, input, true);
    return {
      received: sources.length,
      inserted: 0,
      alreadyAvailable: 0,
      queued: 0,
    };
  }

  const newIds = newSources.map((source) => source.providerId);
  const availableRows = await database
    .select({ providerId: transcripts.providerId })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.provider, "youtube"),
        inArray(transcripts.providerId, newIds),
      ),
    );
  const availableIds = new Set(availableRows.map((row) => row.providerId));
  const needingJobs = newSources.filter(
    (source) => !availableIds.has(source.providerId),
  );
  if (needingJobs.length) {
    await database
      .insert(jobs)
      .values(
        needingJobs.map((source) => ({
          id: crypto.randomUUID(),
          provider: "youtube",
          providerId: source.providerId,
          sourceUrl: source.sourceUrl,
        })),
      )
      .onConflictDoNothing({
        target: [jobs.provider, jobs.providerId],
      });
  }
  const jobRows = needingJobs.length
    ? await database
        .select({
          id: jobs.id,
          providerId: jobs.providerId,
          status: jobs.status,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.provider, "youtube"),
            inArray(
              jobs.providerId,
              needingJobs.map((source) => source.providerId),
            ),
          ),
        )
    : [];
  const jobsByVideo = new Map(jobRows.map((row) => [row.providerId, row]));
  await database.insert(channelVideos).values(
    newSources.map((source) => {
      const job = jobsByVideo.get(source.providerId);
      return {
        id: `${id}:${source.providerId}`,
        channelJobId: id,
        provider: "youtube",
        providerId: source.providerId,
        sourceUrl: source.sourceUrl,
        title: source.title?.trim().slice(0, 500) ?? "",
        jobId: job?.id ?? null,
        status: availableIds.has(source.providerId)
          ? "complete"
          : normalizeVideoJobStatus(job?.status),
      };
    }),
  );
  await updateChannelMetadata(id, input, true);
  return {
    received: sources.length,
    inserted: newSources.length,
    alreadyAvailable: newSources.filter((source) =>
      availableIds.has(source.providerId),
    ).length,
    queued: newSources.filter(
      (source) => !availableIds.has(source.providerId),
    ).length,
  };
}

export async function completeChannelDiscovery(id: string): Promise<void> {
  await ensureDatabase();
  await getDb()
    .update(channelJobs)
    .set({
      status: "processing",
      error: null,
      discoveryCompletedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelJobs.id, id));
  await refreshChannelCompletion(id);
}

export async function failChannelJob(id: string, error: string): Promise<void> {
  await ensureDatabase();
  const [job] = await getDb()
    .select()
    .from(channelJobs)
    .where(eq(channelJobs.id, id))
    .limit(1);
  if (!job) throw new Error("Channel job not found");
  await getDb()
    .update(channelJobs)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      error: error.slice(0, 1000),
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelJobs.id, id));
}

export async function getChannelProgress(
  id: string,
): Promise<ChannelProgress | null> {
  await ensureDatabase();
  const [row] = await getDb()
    .select()
    .from(channelJobs)
    .where(eq(channelJobs.id, id))
    .limit(1);
  if (!row) return null;
  return channelProgress(mapChannelJob(row));
}

export async function listChannelProgress(
  limit = 25,
): Promise<ChannelProgress[]> {
  await ensureDatabase();
  const rows = await getDb()
    .select()
    .from(channelJobs)
    .orderBy(desc(channelJobs.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return Promise.all(rows.map((row) => channelProgress(mapChannelJob(row))));
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
  return (await claimJobs(workerId, 1))[0] ?? null;
}

export async function claimJobs(
  workerId: string,
  limit = 1,
): Promise<IngestionJob[]> {
  await ensureDatabase();
  const database = getDb();
  const safeLimit = Math.max(1, Math.min(limit, 10));
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

  const candidates = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lt(jobs.attempts, 3)))
    .orderBy(asc(jobs.createdAt))
    .limit(safeLimit);
  if (!candidates.length) return [];

  const claimed = await database
    .update(jobs)
    .set({
      status: "processing",
      workerId,
      attempts: sql`${jobs.attempts} + 1`,
      claimedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        inArray(
          jobs.id,
          candidates.map((candidate) => candidate.id),
        ),
        eq(jobs.status, "queued"),
      ),
    )
    .returning();
  if (claimed.length) {
    await database
      .update(channelVideos)
      .set({
        status: "processing",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        inArray(
          channelVideos.jobId,
          claimed.map((job) => job.id),
        ),
      );
  }
  return claimed.map(mapJob);
}

export async function completeJob(
  id: string,
  transcript: TranscriptRecord,
  processingSeconds?: number,
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
      processingSeconds:
        processingSeconds == null
          ? job.processingSeconds
          : Math.max(0, Math.round(processingSeconds)),
      completedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(jobs.id, id));
  await getDb()
    .update(channelVideos)
    .set({ status: "complete", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(channelVideos.jobId, id));
  const channelIds = await channelIdsForJob(id);
  await Promise.all(channelIds.map(refreshChannelCompletion));
}

export async function failJob(
  id: string,
  error: string,
  processingSeconds?: number,
): Promise<void> {
  await ensureDatabase();
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  await getDb()
    .update(jobs)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      error: error.slice(0, 1000),
      processingSeconds:
        processingSeconds == null
          ? job.processingSeconds
          : Math.max(0, Math.round(processingSeconds)),
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(jobs.id, id));
  await getDb()
    .update(channelVideos)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelVideos.jobId, id));
  const channelIds = await channelIdsForJob(id);
  await Promise.all(channelIds.map(refreshChannelCompletion));
}

export async function getChannelSearchJob(
  id: string,
): Promise<ChannelSearchJob | null> {
  await ensureDatabase();
  const [row] = await getDb()
    .select()
    .from(channelSearchJobs)
    .where(eq(channelSearchJobs.id, id))
    .limit(1);
  return row ? mapChannelSearchJob(row) : null;
}

export async function getChannelSearchJobForQuery(
  query: string,
): Promise<ChannelSearchJob | null> {
  await ensureDatabase();
  const normalizedQuery = normalizeTopicQuery(query);
  if (!normalizedQuery) return null;
  const [row] = await getDb()
    .select()
    .from(channelSearchJobs)
    .where(eq(channelSearchJobs.normalizedQuery, normalizedQuery))
    .limit(1);
  return row ? mapChannelSearchJob(row) : null;
}

export async function createOrRefreshChannelSearchJob(
  query: string,
  resultLimit = 8,
): Promise<{
  job: ChannelSearchJob;
  created: boolean;
  refreshed: boolean;
}> {
  await ensureDatabase();
  const cleanQuery = query.replace(/\s+/g, " ").trim().slice(0, 200);
  const normalizedQuery = normalizeTopicQuery(cleanQuery);
  if (!normalizedQuery) throw new Error("Channel query is too broad or empty");
  const safeLimit = Math.max(1, Math.min(resultLimit, 15));
  const database = getDb();
  const [created] = await database
    .insert(channelSearchJobs)
    .values({
      id: crypto.randomUUID(),
      query: cleanQuery,
      normalizedQuery,
      resultLimit: safeLimit,
    })
    .onConflictDoNothing({ target: channelSearchJobs.normalizedQuery })
    .returning();
  if (created) {
    return {
      job: mapChannelSearchJob(created),
      created: true,
      refreshed: false,
    };
  }

  const existing = await getChannelSearchJobForQuery(cleanQuery);
  if (!existing) throw new Error("Channel search job was not created");
  const stale =
    existing.status === "complete" &&
    Date.parse(existing.updatedAt) < Date.now() - 24 * 60 * 60 * 1000;
  if (
    existing.status === "processing" ||
    (existing.status !== "failed" && !stale)
  ) {
    return { job: existing, created: false, refreshed: false };
  }
  const [refreshed] = await database
    .update(channelSearchJobs)
    .set({
      query: cleanQuery,
      status: "queued",
      resultLimit: safeLimit,
      resultsJson: "[]",
      attempts: 0,
      workerId: null,
      error: null,
      claimedAt: null,
      completedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelSearchJobs.id, existing.id))
    .returning();
  if (!refreshed) throw new Error("Channel search job was not refreshed");
  return {
    job: mapChannelSearchJob(refreshed),
    created: false,
    refreshed: true,
  };
}

export async function claimChannelSearchJob(
  workerId: string,
): Promise<ChannelSearchJob | null> {
  await ensureDatabase();
  const database = getDb();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await database
    .update(channelSearchJobs)
    .set({
      status: "queued",
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(channelSearchJobs.status, "processing"),
        lt(channelSearchJobs.claimedAt, staleBefore),
        lt(channelSearchJobs.attempts, 3),
      ),
    );
  const [candidate] = await database
    .select({ id: channelSearchJobs.id })
    .from(channelSearchJobs)
    .where(
      and(
        eq(channelSearchJobs.status, "queued"),
        lt(channelSearchJobs.attempts, 3),
      ),
    )
    .orderBy(asc(channelSearchJobs.createdAt))
    .limit(1);
  if (!candidate) return null;
  const [claimed] = await database
    .update(channelSearchJobs)
    .set({
      status: "processing",
      workerId,
      attempts: sql`${channelSearchJobs.attempts} + 1`,
      claimedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(channelSearchJobs.id, candidate.id),
        eq(channelSearchJobs.status, "queued"),
      ),
    )
    .returning();
  return claimed ? mapChannelSearchJob(claimed) : null;
}

export async function completeChannelSearchJob(
  id: string,
  candidates: ChannelCandidate[],
): Promise<void> {
  await ensureDatabase();
  const results = [
    ...new Map(
      candidates
        .map((candidate) => {
          const channelId = candidate.channelId.trim().slice(0, 100);
          if (!/^[A-Za-z0-9_-]{10,100}$/.test(channelId)) return null;
          return {
            channelId,
            name: candidate.name.trim().slice(0, 500) || channelId,
            url: `https://www.youtube.com/channel/${channelId}`,
            description: candidate.description.trim().slice(0, 1000),
          };
        })
        .filter((candidate) => candidate !== null)
        .map((candidate) => [candidate.channelId, candidate]),
    ).values(),
  ].slice(0, 15);
  const [updated] = await getDb()
    .update(channelSearchJobs)
    .set({
      status: "complete",
      resultsJson: JSON.stringify(results),
      error: null,
      completedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelSearchJobs.id, id))
    .returning({ id: channelSearchJobs.id });
  if (!updated) throw new Error("Channel search job not found");
}

export async function failChannelSearchJob(
  id: string,
  error: string,
): Promise<void> {
  await ensureDatabase();
  const job = await getChannelSearchJob(id);
  if (!job) throw new Error("Channel search job not found");
  await getDb()
    .update(channelSearchJobs)
    .set({
      status: job.attempts >= 3 ? "failed" : "queued",
      error: error.slice(0, 1000),
      workerId: null,
      claimedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelSearchJobs.id, id));
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
  const textSearchQuery = tokens.join(" ");
  const vector = sql`"transcripts"."search_vector"`;
  const query = sql`plainto_tsquery('english', ${textSearchQuery})`;
  const rows = await getDb()
    .select()
    .from(transcripts)
    .where(sql`${vector} @@ ${query}`)
    .orderBy(sql`ts_rank(${vector}, ${query}) DESC`, desc(transcripts.updatedAt))
    .limit(safeLimit);

  return rows.map((row) => {
    const transcript = mapTranscript(row);
    return {
      ...transcript,
      snippet: makeSnippet(transcript.transcriptText, tokens),
    };
  });
}

export async function searchChannels(
  rawQuery: string,
  limit = 10,
): Promise<ChannelProgress[]> {
  await ensureDatabase();
  const tokens = meaningfulTokens(rawQuery);
  if (!tokens.length) return [];
  const safeLimit = Math.max(1, Math.min(limit, 25));
  const searchable = sql`lower(concat_ws(' ',
    ${channelJobs.channelName},
    coalesce(${channelJobs.channelId}, ''),
    ${channelJobs.normalizedUrl}
  ))`;
  const rows = await getDb()
    .select()
    .from(channelJobs)
    .where(
      and(
        ...tokens.map(
          (token) => sql`position(${token} in ${searchable}) > 0`,
        ),
      ),
    )
    .orderBy(desc(channelJobs.updatedAt))
    .limit(safeLimit);
  return Promise.all(
    rows.map((row) => channelProgress(mapChannelJob(row))),
  );
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
  channelQueued: number;
  channelDiscovering: number;
  channelProcessing: number;
}> {
  await ensureDatabase();
  const database = getDb();
  const [
    [transcriptCount],
    [queuedCount],
    [processingCount],
    [topicQueuedCount],
    [topicProcessingCount],
    [channelQueuedCount],
    [channelDiscoveringCount],
    [channelProcessingCount],
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
      database
        .select({ value: count() })
        .from(channelJobs)
        .where(eq(channelJobs.status, "queued")),
      database
        .select({ value: count() })
        .from(channelJobs)
        .where(eq(channelJobs.status, "discovering")),
      database
        .select({ value: count() })
        .from(channelJobs)
        .where(eq(channelJobs.status, "processing")),
    ]);
  return {
    transcripts: transcriptCount?.value ?? 0,
    queued: queuedCount?.value ?? 0,
    processing: processingCount?.value ?? 0,
    topicQueued: topicQueuedCount?.value ?? 0,
    topicProcessing: topicProcessingCount?.value ?? 0,
    channelQueued: channelQueuedCount?.value ?? 0,
    channelDiscovering: channelDiscoveringCount?.value ?? 0,
    channelProcessing: channelProcessingCount?.value ?? 0,
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

async function updateChannelMetadata(
  id: string,
  input: {
    channelId?: string;
    channelName?: string;
    channelUrl?: string;
    reportedVideoCount?: number;
  },
  incrementBatch: boolean,
): Promise<void> {
  await getDb()
    .update(channelJobs)
    .set({
      ...(input.channelId
        ? { channelId: input.channelId.trim().slice(0, 200) }
        : {}),
      ...(input.channelName
        ? { channelName: input.channelName.trim().slice(0, 500) }
        : {}),
      ...(input.channelUrl
        ? { channelUrl: input.channelUrl.trim().slice(0, 1000) }
        : {}),
      ...(Number.isFinite(input.reportedVideoCount)
        ? {
            reportedVideoCount: Math.max(
              0,
              Math.round(input.reportedVideoCount ?? 0),
            ),
          }
        : {}),
      ...(incrementBatch
        ? { batchesReceived: sql`${channelJobs.batchesReceived} + 1` }
        : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelJobs.id, id));
}

async function channelProgress(job: ChannelJob): Promise<ChannelProgress> {
  const database = getDb();
  const [stats] = await database
    .select({
      discovered: count(),
      completed: sql<number>`count(*) filter (where ${channelVideos.status} = 'complete')`,
      queued: sql<number>`count(*) filter (where ${channelVideos.status} = 'queued')`,
      processing: sql<number>`count(*) filter (where ${channelVideos.status} = 'processing')`,
      failed: sql<number>`count(*) filter (where ${channelVideos.status} = 'failed')`,
      averageSeconds: sql<number | null>`avg(${jobs.processingSeconds}) filter (
        where ${channelVideos.status} = 'complete'
        and ${jobs.processingSeconds} is not null
      )`,
    })
    .from(channelVideos)
    .leftJoin(jobs, eq(channelVideos.jobId, jobs.id))
    .where(eq(channelVideos.channelJobId, job.id));
  const discoveredVideos = Number(stats?.discovered ?? 0);
  const completedVideos = Number(stats?.completed ?? 0);
  const queuedVideos = Number(stats?.queued ?? 0);
  const processingVideos = Number(stats?.processing ?? 0);
  const failedVideos = Number(stats?.failed ?? 0);
  const failureRows =
    failedVideos > 0
      ? await database
          .select({
            error: jobs.error,
            value: count(),
          })
          .from(channelVideos)
          .leftJoin(jobs, eq(channelVideos.jobId, jobs.id))
          .where(
            and(
              eq(channelVideos.channelJobId, job.id),
              eq(channelVideos.status, "failed"),
            ),
          )
          .groupBy(jobs.error)
      : [];
  const failureReasons = failureRows
    .map((row) => ({
      reason: channelFailureReason(row.error),
      count: Number(row.value),
    }))
    .sort((left, right) => right.count - left.count);
  let averageProcessingSeconds =
    stats?.averageSeconds == null ? null : Number(stats.averageSeconds);
  if (!averageProcessingSeconds && queuedVideos + processingVideos > 0) {
    const [globalTiming] = await database
      .select({
        averageSeconds: sql<number | null>`avg(${jobs.processingSeconds})`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "complete"),
          isNotNull(jobs.processingSeconds),
        ),
      );
    averageProcessingSeconds =
      globalTiming?.averageSeconds == null
        ? null
        : Number(globalTiming.averageSeconds);
  }
  const terminalVideos = completedVideos + failedVideos;
  const denominator = Math.max(
    discoveredVideos,
    job.reportedVideoCount ?? 0,
  );
  const undiscovered = Math.max(0, denominator - discoveredVideos);
  const remaining = queuedVideos + processingVideos + undiscovered;
  const started = Date.parse(job.claimedAt ?? job.createdAt);
  const ended = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((ended - started) / 1000));
  const observedVideosPerMinute =
    terminalVideos >= 3 && elapsedSeconds > 0
      ? (terminalVideos * 60) / elapsedSeconds
      : null;
  const estimatedSecondsRemaining =
    remaining === 0
      ? 0
      : observedVideosPerMinute
        ? Math.ceil((remaining / observedVideosPerMinute) * 60)
        : averageProcessingSeconds
          ? Math.ceil(
              (remaining * averageProcessingSeconds) /
                Math.max(1, job.concurrency),
            )
          : null;
  const transcriptCoveragePercent =
    denominator > 0
      ? Math.min(100, Math.round((completedVideos / denominator) * 100))
      : 0;
  const fullyCovered =
    denominator > 0 &&
    completedVideos >= denominator &&
    failedVideos === 0 &&
    queuedVideos === 0 &&
    processingVideos === 0;
  return {
    ...job,
    discoveredVideos,
    completedVideos,
    queuedVideos,
    processingVideos,
    failedVideos,
    elapsedSeconds,
    averageProcessingSeconds,
    observedVideosPerMinute,
    estimatedSecondsRemaining,
    transcriptCoveragePercent,
    fullyCovered,
    failureReasons,
    progressPercent:
      denominator > 0
        ? Math.min(100, Math.round((terminalVideos / denominator) * 100))
        : 0,
  };
}

function channelFailureReason(error: string | null): string {
  const value = (error ?? "").toLowerCase();
  if (value.includes("no captions found") && value.includes("permission")) {
    return "No captions; local ASR was not permitted for this channel";
  }
  if (
    value.includes("private video") ||
    value.includes("video unavailable") ||
    value.includes("not available")
  ) {
    return "Video is private, deleted, blocked, or unavailable";
  }
  if (value.includes("sign in") || value.includes("age")) {
    return "Video requires sign-in or age verification";
  }
  if (value.includes("install mlx-whisper") || value.includes("whisper.cpp")) {
    return "Local ASR is permitted but no Whisper engine is configured";
  }
  if (value.includes("timed out") || value.includes("timeout")) {
    return "YouTube or registry request timed out after retries";
  }
  return error?.trim().slice(0, 240) || "Unknown processing failure";
}

async function refreshChannelCompletion(id: string): Promise<void> {
  const database = getDb();
  const [channel] = await database
    .select({
      discoveryCompletedAt: channelJobs.discoveryCompletedAt,
      status: channelJobs.status,
    })
    .from(channelJobs)
    .where(eq(channelJobs.id, id))
    .limit(1);
  if (
    !channel?.discoveryCompletedAt ||
    channel.status === "failed"
  ) {
    return;
  }
  const [pending] = await database
    .select({ value: count() })
    .from(channelVideos)
    .where(
      and(
        eq(channelVideos.channelJobId, id),
        inArray(channelVideos.status, ["queued", "processing"]),
      ),
    );
  const complete = Number(pending?.value ?? 0) === 0;
  await database
    .update(channelJobs)
    .set({
      status: complete ? "complete" : "processing",
      ...(complete ? { completedAt: sql`CURRENT_TIMESTAMP` } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(channelJobs.id, id));
}

async function channelIdsForJob(id: string): Promise<string[]> {
  const rows = await getDb()
    .select({ channelJobId: channelVideos.channelJobId })
    .from(channelVideos)
    .where(eq(channelVideos.jobId, id));
  return [...new Set(rows.map((row) => row.channelJobId))];
}

function normalizeVideoJobStatus(status?: string): string {
  return ["queued", "processing", "complete", "failed"].includes(status ?? "")
    ? String(status)
    : "queued";
}

function requiredChannel(value: ChannelProgress | null): ChannelProgress {
  if (!value) throw new Error("Channel job not found");
  return value;
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
    processingSeconds: row.processingSeconds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
  };
}

function mapChannelJob(row: ChannelJobRow): ChannelJob {
  return {
    id: row.id,
    inputUrl: row.inputUrl,
    normalizedUrl: row.normalizedUrl,
    channelId: row.channelId,
    channelName: row.channelName,
    channelUrl: row.channelUrl,
    status: row.status as ChannelJob["status"],
    reportedVideoCount: row.reportedVideoCount,
    batchSize: row.batchSize,
    concurrency: row.concurrency,
    batchesReceived: row.batchesReceived,
    attempts: row.attempts,
    workerId: row.workerId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    discoveryCompletedAt: row.discoveryCompletedAt,
    completedAt: row.completedAt,
  };
}

function mapChannelSearchJob(row: ChannelSearchJobRow): ChannelSearchJob {
  return {
    id: row.id,
    query: row.query,
    normalizedQuery: row.normalizedQuery,
    status: row.status as ChannelSearchJob["status"],
    resultLimit: row.resultLimit,
    results: safeJson<ChannelCandidate[]>(row.resultsJson, []),
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
