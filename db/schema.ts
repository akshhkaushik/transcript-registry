import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const transcripts = pgTable(
  "transcripts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    title: text("title").notNull(),
    channel: text("channel").notNull().default(""),
    channelUrl: text("channel_url"),
    description: text("description").notNull().default(""),
    publishedAt: text("published_at"),
    durationSeconds: integer("duration_seconds"),
    language: text("language").notNull().default("en"),
    transcriptSource: text("transcript_source").notNull(),
    license: text("license").notNull().default("unknown"),
    attribution: text("attribution").notNull().default(""),
    topicsJson: text("topics_json").notNull().default("[]"),
    transcriptText: text("transcript_text").notNull(),
    segmentsJson: text("segments_json").notNull(),
    wordCount: integer("word_count").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transcripts_provider_video_idx").on(
      table.provider,
      table.providerId,
    ),
    index("transcripts_updated_at_idx").on(table.updatedAt),
  ],
);

export const channelJobs = pgTable(
  "channel_jobs",
  {
    id: text("id").primaryKey(),
    inputUrl: text("input_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    channelId: text("channel_id"),
    channelName: text("channel_name").notNull().default(""),
    channelUrl: text("channel_url"),
    status: text("status").notNull().default("queued"),
    reportedVideoCount: integer("reported_video_count"),
    batchSize: integer("batch_size").notNull().default(50),
    concurrency: integer("concurrency").notNull().default(4),
    batchesReceived: integer("batches_received").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    claimedAt: timestampColumn("claimed_at"),
    discoveryCompletedAt: timestampColumn("discovery_completed_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("channel_jobs_normalized_url_idx").on(table.normalizedUrl),
    index("channel_jobs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    error: text("error"),
    processingSeconds: integer("processing_seconds"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    claimedAt: timestampColumn("claimed_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("jobs_provider_video_idx").on(table.provider, table.providerId),
    index("jobs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const channelVideos = pgTable(
  "channel_videos",
  {
    id: text("id").primaryKey(),
    channelJobId: text("channel_job_id")
      .notNull()
      .references(() => channelJobs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("youtube"),
    providerId: text("provider_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    title: text("title").notNull().default(""),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channel_videos_channel_video_idx").on(
      table.channelJobId,
      table.providerId,
    ),
    index("channel_videos_channel_status_idx").on(
      table.channelJobId,
      table.status,
    ),
    index("channel_videos_job_idx").on(table.jobId),
  ],
);

export const topicJobs = pgTable(
  "topic_jobs",
  {
    id: text("id").primaryKey(),
    query: text("query").notNull(),
    normalizedQuery: text("normalized_query").notNull(),
    status: text("status").notNull().default("queued"),
    targetCount: integer("target_count").notNull().default(8),
    foundCount: integer("found_count").notNull().default(0),
    enqueuedCount: integer("enqueued_count").notNull().default(0),
    availableCount: integer("available_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    claimedAt: timestampColumn("claimed_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("topic_jobs_normalized_query_idx").on(table.normalizedQuery),
    index("topic_jobs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const channelSearchJobs = pgTable(
  "channel_search_jobs",
  {
    id: text("id").primaryKey(),
    query: text("query").notNull(),
    normalizedQuery: text("normalized_query").notNull(),
    status: text("status").notNull().default("queued"),
    resultLimit: integer("result_limit").notNull().default(8),
    resultsJson: text("results_json").notNull().default("[]"),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    claimedAt: timestampColumn("claimed_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("channel_search_jobs_query_idx").on(table.normalizedQuery),
    index("channel_search_jobs_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const submissionEvents = pgTable(
  "submission_events",
  {
    id: text("id").primaryKey(),
    clientHash: text("client_hash").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("submission_events_client_time_idx").on(
      table.clientHash,
      table.createdAt,
    ),
  ],
);
